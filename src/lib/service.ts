'use strict';

import { RTMClient, RTMCallResult } from '@slack/rtm-api';
import axios from 'axios';
import Form from 'form-data';

import * as Search from './search';
import * as img from './img';
import { Store, NotFoundError } from './store';

export interface Config {
  bottoken: string;
  admintoken: string;
  dbfile: string;
}

export default class WittyService {
  private store: Store;

  private admintoken: string;
  private bottoken: string;
  private conversationId: string;
  private id: string;
  private rtm: RTMClient;
  private teamname: string;

  public constructor(config: Config) {
    this.store = new Store(config.dbfile);

    const [meta, err] = this.store.loadMeta();
    if (err) {
      this.error('Could not load config from db', {
        err,
      });
      throw err;
    }
    if (!meta) {
      this.error('Could not load config from db', {
        err,
      });
      throw err;
    }

    this.admintoken = config.admintoken;
    this.bottoken = config.bottoken;
    this.conversationId = meta.homechannelid;
    this.id = meta.botid;
    this.teamname = meta.team;

    this.rtm = new RTMClient(this.bottoken);
  }

  public async start() {
    try {
      await this.rtm.start();
    } catch (err) {
      this.error('Could not start bot', {
        err,
      });
      process.exit(1);
    }

    this.rtm.on('message', (msg: MessageEvent) => this.dispatch(msg));
    this.rtm.on('reaction_added', (event: ReactionEvent) => this.handleAddReaction(event));
    this.rtm.on('reaction_removed', (event: ReactionEvent) => this.handleRemoveReaction(event));

    this.info('Bot is running', {
      botid: this.id,
      homechannelid: this.conversationId,
      team: this.teamname,
    });
  }

  // dispatch handles all mentions in the home channel.
  public async dispatch(msg: MessageEvent) {
    const { text, user, channel } = msg;
    const mention = `<@${this.id}>`;
    const User = `<@${user}>`;
    // Only respond to messages from other users to self.
    if (!text || !text.includes(mention) || user === this.id || channel !== this.conversationId) {
      return;
    }

    const words = text.trim().split(/\s+/);
    // TODO: This indexOf will fail for mentions with punctuation, e.g., "@witty, ..."
    const [cmd, ...args] = words.slice(words.indexOf(mention) + 1);

    type Handler = (u: string, args: string[], msg: MessageEvent) => Promise<void>;
    let handler: Handler;

    switch (cmd) {
      case 'delete!':
        handler = this.handleDelete;
        break;
      case 'find!':
        handler = this.handleFind;
        break;
      case 'more!':
        handler = this.handleMore;
        break;
      case 'create!':
        handler = this.handleCreate;
        break;
      case 'whomade!':
        handler = this.handleWhomade;
        break;
      case 'help!':
        handler = () => this.sendUsage();
        break;
      case 'leaders!':
        handler = this.handleLeaders;
        break;
      default:
        this.sendMessage(`Sorry ${User}, I don't know the command ${cmd}`);
        return;
    }

    try {
      await handler.call(this, User, args, msg);
    } catch (err) {
      this.error('Unhandled exception', { err, origin: msg });
      this.sendMessage(`Sorry, ${User}. I ran into an unhandled exception.\n> *Error:* ${err}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async handleFind(user: string, terms: string[], _: MessageEvent) {
    const term = terms.join(' ');
    if (term.length < 3) {
      await this.sendMessage(`Sorry, ${user}, please use a search term greater than 3 characters long.`);
      return;
    }

    const [urls, startidx, slug] = await Search.find(user, term);
    const buffer = await img.optionsGrid(urls, slug, startidx);

    await this.uploadOptions(buffer, term, user);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async handleMore(user: string, terms: string[], _: MessageEvent) {
    const term = terms.join(' ');
    const [urls, startidx, slug] = await Search.next(user, term);
    if (slug === Search.DONE) {
      await this.sendMessage(
        `Sorry ${user}, that's all I have for "${term}". Google only serves 60 images at a time. You can use any number of words for a search term, if that helps.`,
      );
      return;
    }

    const buffer = await img.optionsGrid(urls, slug, startidx);

    await this.uploadOptions(buffer, term, user);
  }

  public async handleCreate(user: string, terms: string[], msg: MessageEvent) {
    let needsAuth = false;
    let url: string;
    let keyword: string;

    // Pasted a file attachment: create! emojiname
    if (msg.files) {
      const files = msg.files || [{ url_private_download: 'n/a' }]; // Typescript messiness.
      url = files[0].url_private_download;
      keyword = terms.join('-').toLowerCase();
      needsAuth = true;
    }
    // Copied private link from slack: create! emojiname http://myteam.slack.com/....
    else if (/slack\.com/.test(terms[terms.length - 1])) {
      // These two assignments are order-sensitive.
      url = terms.pop() || '';
      // Slack sends url `foo.com` as `<foo.com>`
      url = url.replace(/[<>]/g, '');
      keyword = terms.join('-').toLowerCase();
      needsAuth = true;
    }
    // Searched-for image: create! emojiname ABCx12
    else if (/^[a-zA-Z]{3}x\d{2}$/.test(terms[terms.length - 1])) {
      // These two assignments are order-sensitive.
      const imageId = terms.pop();
      keyword = terms.join('-').toLowerCase();

      if (!imageId || !keyword) {
        this.sendMessage(`Sorry, ${user}. I can't create a \`:${keyword}:\` emoji from "${imageId}"`);
        return;
      }

      const cachedUrl = Search.urlFor(user, imageId);
      if (!cachedUrl) {
        await this.sendMessage(
          `Sorry ${user}, I don't have a cached image for you under \`${imageId}\`. Please try again.`,
        );
        // TODO: log something.
        return;
      } else {
        url = cachedUrl;
      }
    } else {
      // Pasted a public link: create! emojiname http://imgur.com/iH8eu
      url = terms.pop() || '';
      keyword = terms.join('-').toLowerCase();
      // Slack sends url `foo.com` as `<foo.com>`
      url = url.replace(/[<>]/g, '');
    }

    // --- Build
    const headers = needsAuth ? { Authorization: `Bearer ${this.admintoken}` } : undefined;
    const httpRes = await axios({
      url: url,
      headers,
      responseType: 'arraybuffer',
    });

    const file = httpRes.data;
    const mimeType = httpRes.headers['content-type'];

    // --- Upload
    {
      const err = await this.createEmoji(keyword, file, mimeType);
      if (err !== null) {
        this.sendMessage(
          `Sorry, ${user}. There was an error creating an emoji for \`:${keyword}:\`
> *Error:* ${err}`,
        );

        return;
      }
    }

    // --- Track
    {
      const err = this.store.addEmoji(user, keyword);
      if (err) {
        this.error('failed to add new emoji to db', { user, keyword });
      }
    }

    // --- Reply
    await this.sendMessage(`Thank you, ${user}! You have expanded our world with \`:${keyword}:\` => :${keyword}:`);
    await this.addReaction(msg.channel, msg.ts, keyword);
  }

  private async handleAddReaction(event: ReactionEvent) {
    if (event.item.type !== 'message') {
      return;
    }
    this.store.addReaction(event.reaction, event.item.channel, event.event_ts, event.item.ts);
  }

  private async handleRemoveReaction(event: ReactionEvent) {
    if (event.item.type !== 'message') {
      return;
    }
    this.store.deleteReaction(event.reaction, event.item.channel, event.item.ts);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async handleLeaders(user: string, terms: string[], _: MessageEvent) {
    const N = 10;
    const [leaders, err] = this.store.leaders(N);
    if (err !== null) {
      throw err;
    }
    const displayLeaders = await Promise.all(
      leaders.map(async row => {
        const displayName = await this.userIdToDisplayName(row.user);
        row.user = displayName;
        return row;
      }),
    );
    const namePad = displayLeaders.reduce((len, row) => Math.max(len, row.user.length), 0) + 1;
    const board = displayLeaders
      .map((row, i) => {
        const userPad = ' '.repeat(i < 9 ? 2 : 1);
        const scorePad = ''.padStart(namePad - row.user.length);
        return `${i + 1}.${userPad}${row.user} ${scorePad}(${row.score})`;
      })
      .join('\n');

    await this.sendMessage(`Here's the top ${N} emoji creators!\n\`\`\`\n${board}\n\`\`\``);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async handleDelete(user: string, terms: string[], _: MessageEvent) {
    // Ownership stores user without any slack formatting.
    const requester = user.replace(/[<@>]/g, '');
    const emoji = terms[0];
    if (terms.length !== 1 || !/^:\S+:$/.test(emoji)) {
      await this.sendMessage(`Sorry ${user}. \`${terms.join(' ')}\` is not a valid emoji name.`);
      return;
    }

    let [owner, err] = this.store.owner(emoji);
    if (err) {
      if (err === NotFoundError) {
        // Let's let them try to delete it if we don't know who created it.
        owner = requester;
      } else {
        throw err;
      }
    }

    if (requester !== owner) {
      const ownerName = await this.userIdToDisplayName(owner);
      await this.sendMessage(`Sorry, ${user}, you can't delete ${emoji}. It's owned by ${ownerName}.`);
      return;
    }

    // --- Delete from slack.
    {
      const form = new Form();
      form.append('token', this.admintoken);
      // The user will pass in `:emoji:`, so that the handler can perform a
      // quick partial validation. Strip it here.
      form.append('name', emoji.replace(/:/g, ''));

      const res = await axios({
        url: `https://${this.teamname}.slack.com/api/emoji.remove`,
        method: 'post',
        data: form,
        headers: form.getHeaders(),
      });
      if (!res.data.ok) {
        const error = res.data.error;
        await this.sendMessage(
          `Sorry, ${user}. There was an error deleting the \`${emoji}\` emoji:
> *Error:* ${error}`,
        );
        return;
      }
    }

    // --- Untrack
    {
      const err = this.store.deleteEmoji(emoji);
      if (err !== null) {
        this.error('could not delete emoji from db', { err, emoji, requester });
      }
    }

    // --- Reply
    await this.sendMessage(
      `I've deleted the \`${emoji}\` emoji, ${user}. You can assign it to a new image if you like.`,
    );
  }

  public async handleWhomade(user: string, terms: string[], msg: MessageEvent) {
    const emoji = terms[0].replace(/\?$/, ''); // in case user says `whomade! :happy-cows:?`
    if (!/^:\S+:$/.test(emoji)) {
      await this.sendMessage(`Sorry ${user}. \`${emoji}\` is not a valid emoji name.`);

      return;
    }

    const [owner, err] = this.store.owner(emoji);
    if (err) {
      if (err === NotFoundError) {
        await this.sendMessage(`I don't know who made ${emoji}. It's probably built-in`);
        return;
      } else {
        throw err;
      }
    }
    const ownerName = await this.userIdToDisplayName(owner);

    const keyword = emoji.replace(/:/g, '');
    const reply = await this.sendMessage(`${user}, you can thank ${ownerName} for their handywork.`);
    if (reply) {
      await this.addReaction(msg.channel, reply.ts, keyword);
    }
  }

  private async createEmoji(name: string, file: Buffer, mime: string): Promise<Error | null> {
    const form = new Form();
    form.append('mode', 'data');
    form.append('name', name.toLowerCase());
    form.append('token', this.admintoken);

    const ext = mime.split('/')[1];

    form.append('image', file, {
      filename: `${name.toLowerCase()}.${ext}`,
      contentType: mime,
    });

    const res = await axios({
      url: `https://${this.teamname}.slack.com/api/emoji.add`,
      method: 'post',
      data: form,
      headers: form.getHeaders(),
    });

    const { data } = res;
    if (!data.ok) {
      return data.error;
    }
    return null;
  }

  // addReaction is just some additional flare for creating new emoji.
  private async addReaction(channel: string, ts: string, name: string) {
    const res = await axios({
      url: 'https://slack.com/api/reactions.add',
      method: 'post',
      params: {
        token: this.bottoken,
        timestamp: ts,
        channel,
        name,
      },
    });

    if (!res.data.ok) {
      this.error('Could not add reaction', { response: res.data });
    }
  }

  // uploadOptions sends a grid of images matching the search term.
  private async uploadOptions(file: object, searchTerm: string, user: string) {
    const comment = `Hey ${user}, here are some options for *${searchTerm}*.`;
    const form = new Form();
    const filename = `${searchTerm.replace(/\s/g, '-')}-options.jpg`;
    form.append('token', this.bottoken);
    form.append('channels', this.conversationId);
    form.append('filetype', 'auto');
    form.append('file', file, filename);
    form.append('initial_comment', comment);

    await axios.request({
      method: 'post',
      url: 'https://slack.com/api/files.upload',
      data: form,
      headers: form.getHeaders(),
    });
  }

  private async sendMessage(msg: string): Promise<RTMCallResult | void> {
    try {
      const res = await this.rtm.sendMessage(msg, this.conversationId);
      if (res.error) {
        this.error('SendMessageError', { attempt: msg, error: res.error });
      } else {
        return res;
      }
    } catch (err) {
      this.error('Cannot send messages', { err });
    }
  }

  private error(msg: string, meta?: object) {
    // eslint-disable-next-line
		console.error(msg, meta && JSON.stringify(meta));
  }

  private info(msg: string, meta?: object) {
    // eslint-disable-next-line
		console.error(msg, meta && JSON.stringify(meta));
  }

  private async sendUsage() {
    const handlers = {
      'delete!': "`@BOT delete! :happy-cows:` Delete an emoji that I've created.",
      'find!': '`@BOT find! happy cows` Search for a term.',
      'more!': '`@BOT more! happy cows` Show the next chunk of options for a term.',
      'create!':
        '`@BOT create! <emoji_name> <img_ref?>` Create a new emoji. Attach an image or pass in a reference. The reference can be a cache id (e.g., `HAPx01`) or a url.',
      'leaders!': '`@BOT leaders!` Show the top 10 emoji creators.',
      'whomade!': '`@BOT whomade! :happy-cows:` Find out who made your favorite emoji.',
      'help!': '`@BOT help!` Show usage info.',
    };

    const self = `<@${this.id}>`;
    const operations = Object.values(handlers)
      .map(desc => `  • ${desc.replace('@BOT', self)}`)
      .join('\n');

    const usage = `*Here are the commands I understand:*\n${operations}`;
    await this.sendMessage(usage);
  }

  // TODO: not public, pull into other cmd.scrapeEmoji pulls emoji ownership for all emoji in the workspace.
  public async scrapeEmoji(): Promise<EmojiListEntry[]> {
    interface ListResponse {
      data: {
        ok: boolean;
        emoji: EmojiListEntry[];
        paging: {
          page: number;
          pages: number;
        };
      };
    }

    const token = this.admintoken;

    const list: EmojiListEntry[] = [];
    let page = 1;
    let pages: number;
    do {
      const form = new Form();
      form.append('page', page);
      form.append('count', 1000);
      form.append('token', token);

      const res: ListResponse = await axios({
        url: `https://${this.teamname}.slack.com/api/emoji.adminList`,
        method: 'post',
        data: form,
        headers: form.getHeaders(),
      });

      const { data } = res;
      if (!data.ok) {
        return list;
      } else {
        list.push(...res.data.emoji);
        page = res.data.paging.page;
        pages = res.data.paging.pages;
      }
    } while (page < pages);

    return list;
  }

  private async userIdToDisplayName(userid: string): Promise<string> {
    userid = userid.replace(/[<@>]/g, '');
    interface InfoResponse {
      data: {
        ok: boolean;
        user: {
          id: string;
          name: string;
          real_name: string;
        };
      };
    }

    const res: InfoResponse = await axios({
      url: `https://${this.teamname}.slack.com/api/users.info`,
      method: 'get',
      params: {
        token: this.bottoken,
        user: userid,
      },
      headers: {
        'Content-type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.data.ok) {
      this.error('could not get user info', { response: res.data });
      return userid;
    } else {
      return res.data.user.name;
    }
  }
}

interface Attachment {
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  user: string;
  url_private: string;
  url_private_download: string;
}
interface MessageEvent {
  channel: string;
  text: string;
  ts: string;
  user: string;
  files?: Attachment[];
  upload?: boolean;
}
interface ReactionEvent {
  type: 'reaction_removed' | 'reaction_added';
  reaction: string; // e.g., "thumbsup"
  item: {
    type: string; // only use for type === "message"
    channel: string; // channel id
    ts: string;
  };
  event_ts: string; // e.g., "1360782804.083113". Use new Date(parseFloat(ts * 1000))
}
interface EmojiListEntry {
  name: string;
  // 0 if original; any aliases are 0.
  is_alias: number;
  // Epoch time
  created: number;
  // user_display_name is also present, but not used here.
  user_id: string;
  user_display_name: string;
}
