# Imperfect Foods README
Hello! Thanks for reviewing my submission. I know that this is a large amount of
code to wade through, and I hope that this document can give you the context
needed to grab onto one or two code paths. I'm not sure if I've struck the right
balance between limiting the scope and illuminating the necessary background
information, but I hope that this document prepares you to dive into the code.

The following sections are outlined here.
  - **User View:** A high-level explanation of what this application does.
  - **Architectural View:** I don't use a lot of comments in this code base, but I
    think that knowing how its architecture is laid out, coupled with some code
    navigation tooling enabled by TypeScript, allows a contributor to make sense
    of things. In this section, **bold** terms refer to components that have
    corresponding files in `src/lib`.
  - **Goals:** This section points to specific code locations that may highlight the
    specific asks in the coding assignment.

I've asked Katie King to send me your email addresses so I can invite you as
guests to a Slack channel where you can use the app, which I think should be
helpful (and, dare I say, fun). Hopefully you will have received an invitation
by now, but if not, please send me an email (lukealbao is my Gmail name). Once
you are there, you can `@witty help!` to see the commands available to you.

## User View
Witty is a slack bot that allows you to search for and create custom emoji
reactions directly in a slack channel. You can upload images as URL links or as
attachments, or you can ask the bot to search Google and choose your image
source from the results.

Users do not interact with witty via slash commands, but rather they drive it
using a handful of easy keyword commands and a mention in a designated
channel. I've found that doing it in this collaborative, open way helps to
socialize new emoji and create a sense of shared ownership over the visual
language in Slack reactions.

## Architectural View
The core bot runs in a single Node.js process and its main entry point is the
`message` event on the core Slack real-time messaging (RTM) library.

The process contains a single **service** instance, which when `start`ed will
wrap the RTM listener in a dispatcher. It declares known event types
corresponding to known keywords and dispatches the incoming message to the
appropriate event handler. The service keeps track of emoji ownership in a local
SQLite database (programmatic emoji management is not officially supported by
Slack), which it accesses through lightweight methods defined on the **store**
class. This database also keeps track of reactions, which enables statistics on
popular emoji and their creators.

All emoji are created by fetching a binary blob from some URL and attaching it
to a form that is sent to Slack. The URLs may be passed in by the user, or they
may be present in the incoming message if the user has attached an
image. Alternatively, the user may first **search** for an appropriate image. In
this case, the service will first issue an image request to Google and scrape
the sources of search results. Using the `Jimp` image processing library, it
will produce a page containing a grid of thumbnails and upload it to Slack. The
user can then choose one for creation; the service **caches** a mapping of the
thumbnails to their source URLs, and will use it to create the desired image.

## Goals
### Asynchronous Logic
This application is fundamentally non-blocking and event-driven as a result of
Node's asynchronous I/O design. The only thing keeping the process running is
the three event listeners declared in
[service.ts#start](https://github.com/lukealbao/witty/tree/imperfect/src/lib/service.ts#L63-L65). The
app requires a lot of network requests, and one main image operation is
asynchronous as well, so it does not require a lot of resources to handle the
load presented by a moderate-sized company. This pattern also allows all
synchronous and asynchronous errors to be handled in a single place (the
`dispatch` function), guaranteeing that the process continues to run as well as
alerting the user.

A particular place to see some of the async work done here is in
[img.ts#optionsGrid](https://github.com/lukealbao/witty/tree/imperfect/src/lib/img.ts#L22). The
`optionsGrid` function needs to serialize the three operations, because each value is
used to compute the succeeding one. This is done using `async/await`. However, we of
course want to leverage the concurrency model where we can, and you can see that
in the `loadThumbnails` function, which provides the first value for `optionsGrid`:
here we need to load and edit the images from a list of URLs, and using
`Promise.all` is the right choice for minimizing the time we wait for I/O.

If you'd like to see the call stack for `optionsGrid`:
[service.ts#dispatch](https://github.com/lukealbao/witty/tree/imperfect/src/lib/service.ts#L96) => [service.ts#handleFind](https://github.com/lukealbao/witty/tree/imperfect/src/lib/service.ts#L135) => [img.ts#optionsGrid](https://github.com/lukealbao/witty/tree/imperfect/src/lib/img.ts#L22).
### Data Manipulation
Again,
[img.ts](https://github.com/lukealbao/witty/tree/imperfect/src/lib/img.ts) will
show the process of deriving a single image grid built from thumbnails, which
are in turn edited images taken from URLs. Here in the [`buildGrid`](https://github.com/lukealbao/witty/tree/imperfect/src/lib/img.ts#L60) function, you
will also see that callers are required to provide a `startidx` parameter, which
allows for a pagination of sorts. This value is statefully held in `cache.ts`.

If you prefer to see some structured text work, you can find a fairly dense set
of manipulation in
[service.ts#handleLeaders](https://github.com/lukealbao/witty/tree/imperfect/src/lib/service.ts#L262),
which prints a table of the top custom emoji creators. This function gets a list
of users from the local database, then fetches each user's current display name
from Slack, and finally builds an ASCII table from the results.
