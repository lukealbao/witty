-- init.sql: Create tables

create table users (
  userid integer primary key autoincrement,
  slackid text not null
);
insert into users (userid, slackid) values(-1, 'witty-default');

create table emoji (
  emojiid integer primary key autoincrement,
  keyword text not null,
  userid integer not null references users(userid) on update cascade on delete cascade,
  -- Builtins do not show up in emoji.list, but we want to track their reactions.
  builtin boolean not null constraint d_emoji_builtin_f default(false),
  created integer not null -- milliseconds since epoch
);

create table channels (
  channelid integer primary key autoincrement,
  name text not null,
  joined boolean not null constraint d_channels_joined_f default(false)
);

create table reactions (
  id integer primary key autoincrement,
  emojiid integer not null references emoji(emojiid) on update cascade on delete cascade,
  channelid integer not null references channels(channelid) on update cascade on delete cascade,
  ts integer not null, -- milliseconds since epoch. Time of reaction.
  itemts integer not null -- milliseconds since epoch. Identifies message reacted to.
);

create table wittymeta (
  team text,
  homechannelid text,
  botid text,
  adminid integer references users(userid),
  createdat constraint d_wittymeta_createdat_now default (datetime('now')),
  updatedat datetime
);

create unique index idx_users_slackid on users(slackid);
create index idx_emoji_userid on emoji(userid);
create unique index idx_channels_name on channels(name);
create unique index idx_emoji_keyword on emoji(keyword);
create index idx_reactions_emojiid on reactions(emojiid);
