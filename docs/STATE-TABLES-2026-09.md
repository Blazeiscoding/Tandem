# State tables: contact, attention, other workspaces and calls

September 25, 2026. This is ticket 8 of the roadmap's first sprint: a small table for each area where the next features will change what happens to a person, written before any of them is built. For each area it records what the source does today, the states proposed, and the cases to prototype before choosing. The roadmap items are E1a (contact controls), B1–B3 (catch-up, follow-up, notification policy), A10 (several workspaces) and D8 (call invitations).

## 1. Who can reach whom (E1a)

**Today.** Anyone with an account in a workspace can open a direct or group conversation with anyone else in it. The server checks only that each person exists ([server.ts](../packages/server/src/server.ts), `POST /api/channels`, the `dm` / `group_dm` branch). Friends are a separate list with requests. Being friends changes nothing about who may send you a message. Nobody can block or mute a person. Only a conversation can be muted.

**Proposed states.** Each person keeps two things about every other person, and one setting of their own:

- Relationship: `none`, `friend` or `blocked`. A block is one-way. The person blocked is not told, but sees the same result as when a setting refuses them.
- Personal mute: `off` or `on`. Their messages stay visible but never interrupt.
- A DM policy: `anyone` (today's behaviour), `people I share a channel with`, or `friends and existing conversations`.

| Action by A towards B          | B has blocked A                                                                                               | B's policy refuses A                          | Otherwise              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------- |
| Open a new DM                  | Refused as "cannot message this person"                                                                       | Becomes a request that B accepts or ignores   | Opens                  |
| Send in an existing DM         | Refused, same wording; history stays for both                                                                 | Allowed: the conversation already exists      | Delivered              |
| Add B to a group DM            | Refused for B only; the group is created without B, with a note                                               | Refused for B only, same note                 | Added                  |
| Mention B in a shared channel  | Delivered, since the channel belongs to its members. No notification for B. B's view shows the message folded | Delivered and notifies as usual               | Delivered and notifies |
| Start or join a huddle B is in | Allowed in a channel. In a DM, refused                                                                        | In a DM, refused unless the DM already exists | Allowed                |
| Ring B (section 4)             | Refused, shown to A as unanswered                                                                             | Refused, shown as unanswered                  | Rings                  |

The server enforces every refusal. The client only explains it. A block never deletes history, and administrators keep their moderation view (E1b).

**Prototype before choosing.**

- Whether "people I share a channel with" is understandable. A public channel anyone can join makes it close to "anyone".
- What a pending DM request shows the sender, and whether its first message is visible to the recipient before accepting.
- What a block does to reactions and thread replies from the blocked person on your own messages.

## 2. Unread, subscribed, follow-up and resolved (B1–B3)

**Today** ([notify.ts](../packages/client-core/src/notify.ts), [store.ts](../packages/server/src/store.ts) `autoFollowThread`, [ThreadFollow](../packages/protocol/src/entities.ts)):

- **Unread** is a read cursor per conversation (`memberships[channelId]`), and per followed thread (`lastReadSeq`). Mark unread moves either cursor back.
- **Subscription** is two separate things. Channel membership has a notify level (`all`, `mentions`, `nothing`) and a mute. Thread following is on for whoever wrote the root or a reply, and anyone may turn it off or on.
- **Follow-up** is Saved: a bookmark with no done state, no reminder and no note.
- **Resolved** does not exist.
- Following a thread shows it in Threads with an unread count, but never notifies on its own. A reply notifies only through the channel's level: every reply at `all`, only replies that name you at `mentions`.

**Proposed.** Four states, each independent, that no action changes as a side effect:

| State        | Belongs to   | Values                                       | Changed by                                                                                   |
| ------------ | ------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Unread       | Each person  | Read cursor per conversation and thread      | Reading; Mark unread                                                                         |
| Subscription | Each person  | Channel level and mute; thread: follow, mute | Joining, writing in a thread, the notification menu                                          |
| Follow-up    | Each person  | none, saved, saved with reminder, done       | Save, Remind me, Done, Reopen                                                                |
| Resolved     | Conversation | open, resolved                               | Anyone allowed to post, B4. Reopens by itself when a reply arrives, and says who reopened it |

What each action changes and leaves alone:

| Action                     | Unread                | Subscription                   | Follow-up                                      | Resolved |
| -------------------------- | --------------------- | ------------------------------ | ---------------------------------------------- | -------- |
| Read a thread              | Cursor to the end     | —                              | —                                              | —        |
| Reply in a thread          | Cursor to the end     | Follow on (today's rule)       | —                                              | Reopens  |
| Mark done on a saved item  | —                     | — (does not unfollow)          | done                                           | —        |
| A new reply to a done item | Unread again          | —                              | Back to saved if followed, and says why        | —        |
| Mute a thread              | Still counts, quietly | Thread mute on; still followed | —                                              | —        |
| Resolve a thread           | —                     | —                              | —                                              | resolved |
| Reminder fires             | —                     | —                              | Stays saved, and interrupts once as a reminder | —        |

Done must not close anybody else's discussion, and Resolved must not mark anything read for anybody.

**Notification decision, current and proposed.** Today's order of rules (`decideNotification`) is: own message, not a member, muted, level `nothing`, level `mentions` without a mention (DMs pass), Do Not Disturb, then DM, mention, broadcast, all. The proposal keeps that order and adds three rules:

1. After "muted": a muted thread is silent unless it names you.
2. After the level check: a reply in a thread you follow interrupts at `mentions`. Whether this is wanted is exactly what needs testing, since today's behaviour may be the preferred one.
3. Quiet hours sit beside Do Not Disturb and give the same reason, `dnd`, so the explanation stays one sentence.

Each decision already carries a reason (`dm`, `mention`, `level`, `dnd` and so on). B3's "why did or didn't this interrupt" can show that reason as it is.

**Prototype before choosing.**

- Whether followed replies should interrupt at `mentions`, measured with the catch-up task in the roadmap's section 7.
- Whether done items are hidden or folded in Saved.
- How a reminder that fires while Do Not Disturb is on waits and then arrives.

## 3. Workspaces that are not open (A10)

**Today** ([App.tsx](../packages/ui/src/App.tsx), `openWorkspace`): the app connects to one workspace at a time. Opening another destroys the previous client, so a workspace that isn't open receives nothing. It gets no notifications, no badge and no unread count until someone opens it again. The desktop and web apps behave the same.

**Proposed contract.**

| Question                 | Proposal                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What stays connected     | Up to three workspaces used in the last week, each with a socket that receives only unread counts and notifications. It does not sync timelines until the workspace is opened. The rest are checked for counts every few minutes. |
| What interrupts          | The same `decideNotification` rules, run with that workspace's own preferences and Do Not Disturb.                                                                                                                                |
| Badges                   | One per workspace in the switcher, with a mention count for each. The window and tray badge is the sum.                                                                                                                           |
| Tapping a notification   | Opens that workspace at the message, through the route from A1 (`#/c/<channel>`). It asks for sign-in if the session has ended there.                                                                                             |
| Session ended or revoked | Its badge shows "signed out" and it stops notifying. Its credentials are never used again until someone signs in.                                                                                                                 |
| Cost limits              | A socket per background workspace, no message history in memory, and backoff while offline. What the whole app uses with three idle workspaces is measured before this ships.                                                     |

Several accounts on one server count as separate workspaces here. One identity across servers is out of scope (E8).

**Prototype before choosing.** Whether a second socket per workspace is acceptable to a host, or whether the server needs a lighter "counts only" connection. Also, on the web client, what a browser allows a background tab to keep open.

## 4. Call invitations (D8)

**Today** ([huddle.ts](../packages/client-core/src/huddle.ts), `huddle.join` / `huddle.participants` in [events.ts](../packages/protocol/src/events.ts)): a huddle is a room attached to a conversation. People see who is in it and join it themselves. Nothing rings, nothing is missed, and a DM huddle with nobody else in it just waits.

**Proposed lifecycle** for ringing someone from a DM or a small group. It is foreground only: the app has to be open, since background ringing depends on D1.

| From      | Event                                                   | To                                                      |
| --------- | ------------------------------------------------------- | ------------------------------------------------------- |
| idle      | A presses Call                                          | ringing, for up to 30 s. A joins the huddle at once     |
| ringing   | B accepts on any device                                 | connected. Other devices of B stop ringing              |
| ringing   | B declines                                              | declined. A sees "declined", and the huddle remains     |
| ringing   | A cancels, or leaves the huddle                         | cancelled. B sees a missed call                         |
| ringing   | 30 s pass                                               | missed for B, with a Call back action; unanswered for A |
| ringing   | B is already in a call                                  | busy. A sees "in another call"                          |
| ringing   | B has blocked A, or B's DM policy refuses A (section 1) | shown to A as unanswered; nothing reaches B             |
| ringing   | B has Do Not Disturb or quiet hours on                  | no sound for B, and it arrives as a missed call         |
| connected | Either leaves                                           | idle; the huddle continues if others are in it          |

The server decides which state a ring is in and tells every device of both people, so two devices cannot accept the same call. It reuses the huddle's media, so the new work is signalling and presentation. A missed call is a normal entry in the conversation, so it appears in unread and Activity without special handling.

**Prototype before choosing.** What a group call rings: everyone, or only the people named. Whether a missed call should notify at the channel's level or always.

## How this is used

Each table is a starting point for its roadmap item. The prototype questions come before building. The chosen answers should replace the proposals here as each item lands, and a table's first rows should become test cases in `packages/client-core/test` (notification rules) or `packages/server/test` (refusals and ring states).
