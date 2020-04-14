'use strict';

import SQLite from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync } from 'fs';

export const NotFoundError = new Error('no match found');

export class Store {
  private db: SQLite.Database;
  public constructor(dbFile: string, verbose?: (...args: unknown[]) => void) {
    const absoluteLocation = resolve(process.cwd(), dbFile);
    if (!existsSync(absoluteLocation)) {
      throw new Error(`No database at ${absoluteLocation}`);
    }

    this.db = new SQLite(absoluteLocation, { verbose });
    this.db.pragma('foreign_keys=on');
  }

  // Implicitly adds new user if needed.
  public addEmoji(user: string, keyword: string, created?: number): Error | null {
    // Sanitize input
    user = user.replace(/[<@>]/g, '');
    keyword = keyword.replace(/:/g, '');
    // If passed in, it's because we're scraping from slack's UI, which is Unix
    // seconds. Otherwise, it's now. We're using milliseconds since epoch for all
    // timestamps (reactions should have greater precision than seconds).
    if (!created) {
      created = Date.now();
    } else {
      created = created * 1000;
    }

    try {
      const maybeCreateUser = this.db.prepare(`
insert or ignore into users (slackid)
values (:slackid)
`);
      maybeCreateUser.run({ slackid: user });

      const createEmoji = this.db.prepare(`
insert into emoji (userid, keyword, created)
values ((select userid from users u where u.slackid = :slackid), :keyword, :created)
`);
      createEmoji.run({ slackid: user, keyword: keyword, created: created });
    } catch (err) {
      return err;
    }
    return null;
  }

  public owner(keyword: string): [string, Error | null] {
    // Sanitize input
    keyword = keyword.replace(/:/g, '');
    const getOwner = this.db.prepare(`
select u.slackid as user
from users u
join emoji e using(userid)
where e.keyword = :keyword
`);

    interface Row {
      user: string;
    }

    try {
      const row: Row | void = getOwner.get({ keyword }) as Row | void;
      if (!row) {
        return ['', NotFoundError];
      } else {
        return [row.user, null];
      }
    } catch (err) {
      return ['', err as Error];
    }
  }

  public leaders(limit: number): [LeaderRow[], Error | null] {
    const getLeaders = this.db.prepare(`
select u.slackid as user, count(*) as score
from users u
join emoji e using(userid)
group by user
order by score desc
limit :limit
`);
    try {
      const leaders: LeaderRow[] = getLeaders.all({ limit }) as LeaderRow[];
      if (leaders.length < 1) {
        return [[], NotFoundError as Error];
      } else {
        return [leaders, null];
      }
    } catch (err) {
      return [[], err as Error];
    }
  }

  public deleteEmoji(keyword: string): Error | null {
    // Sanitize input
    keyword = keyword.replace(/:/g, '');
    const stmt = this.db.prepare(`
delete from emoji
where keyword = :keyword
`);

    try {
      stmt.run({ keyword });
    } catch (err) {
      return err;
    }
    return null;
  }

  public loadMeta(): [MetaRow | null, Error | null] {
    const stmt = this.db.prepare('select * from wittymeta');
    try {
      const row = stmt.get() as MetaRow | void;
      if (!row) {
        return [null, NotFoundError];
      }
      return [row, null];
    } catch (err) {
      return [null, err as Error];
    }
  }

  // ts is time of reaction, itemts identifies the message being reacted to.
  public addReaction(reaction: string, channel: string, ts: string, itemts: string) {
    // Implicitly create channel if needed.
    {
      const maybeCreateChannel = this.db.prepare(`
insert or ignore into channels (name, joined)
values (:name, true)
`);
      maybeCreateChannel.run({ name: channel });
    }

    // Implicitly create emoji if needed. (e.g., default reactions are not in
    // our db.)
    {
      const maybeCreateEmoji = this.db.prepare(`
insert or ignore into emoji (keyword, userid, builtin, created)
values (:keyword, :unknown, true, 0)
`);
      const params = {
        unknown: -1, // users.userid for built-in emoji owners.
        keyword: reaction,
      };
      maybeCreateEmoji.run(params);
    }

    // Finally, create reaction.
    {
      const createReaction = this.db.prepare(`
insert into reactions (emojiid, channelid, ts, itemts)
values ((select emojiid from emoji where keyword = :reaction),
(select channelid from channels where name = :channel), :ts, :itemts)
`);
      const params = {
        reaction,
        channel,
        ts: this.slackTsToInt(ts),
        itemts: this.slackTsToInt(itemts),
      };
      createReaction.run(params);
    }
  }

  public deleteReaction(reaction: string, channel: string, itemts: string) {
    const stmt = this.db.prepare(`
with e as (select emojiid as id from emoji where keyword = :reaction),
	 c as (select channelid as id from channels where name = :channel)
delete from reactions where id = (
  select id from reactions
  where itemts = :itemts
  and channelid = (select id from c)
  and emojiid = (select id from e)
  limit 1
)
`);

    stmt.run({ reaction, channel, itemts: this.slackTsToInt(itemts) });
  }

  private slackTsToInt(ts: string): number {
    return new Date(parseFloat(ts) * 1000).getTime();
  }
}

interface MetaRow {
  team: string;
  homechannelid: string;
  botid: string;
}
interface LeaderRow {
  user: string;
  score: number;
}
