# Handling copyright complaints and store notices

Streamix is a player and contains no content, so a rights-holder complaint is almost never
about something you host. Complaints still arrive, and in practice what takes an app off a
store is a rights-holder complaint to the store, not a court case. In March 2026, for example,
36 IPTV player apps with more than 26 million downloads were reported removed from Google
Play and the App Store after a sports-rights holder's action, and the list included
well-known generic players:
https://www.storyboard18.com/ott-news/google-play-ios-purge-36-iptv-apps-with-26-million-downloads-taken-down-amid-t20-world-cup-91220.htm

Being a neutral player is not a guarantee. The EU's 2025 Counterfeit and Piracy Watch List
staff document does describe "generic video players" as "not illegal as such", but in the
context of unlicensed IPTV services that tell their users to use such players to reach
infringing content:
https://ec.europa.eu/transparency/documents-register/api/files/SWD(2025)132_0/de00000001071956?rendition=false

So the defence is the design: no built-in content, no recommended providers, a neutral
listing. The process below is about reacting fast and cleanly.

## 1. The contact address

The address in the `publisher` block of `brand.config.json` (the same one used on the
Copyright page, in the Privacy Policy and in Settings > About & legal) is the contact for
copyright notices. It must be:

- a real mailbox, watched every business day by a named person with a named deputy;
- the same address entered as developer contact in Play Console and App Store Connect;
- answered within one business day (acknowledge), and substantively within three.

Store notices arrive in the stores' own consoles (Play Console inbox, App Store Connect
Resolution Center, Samsung and LG seller portals) and by email. Turn on email notifications
in each.

## 2. Triage (within hours)

1. Log the notice (see section 5) with the date and time you received it.
2. Read it and decide which of these it is:

| Type | Typical wording | What to do |
|---|---|---|
| **About content a user streams** | "your app provides access to our channel / match / film" | Section 3 |
| **About the app or its listing** | a logo, screenshot, name, description or code that infringes | Section 4 |
| **About trademarks / naming** | the name Streamix, an icon, a keyword | Section 4 |
| **Store policy notice** (metadata, data safety, permissions, 5.2.x) | a rejection or warning | Section 6 |

3. Check store deadlines. Google and Apple notices often give a few days to respond before
   the app is removed.

## 3. "Your app streams our content"

Reply, politely and the same day if possible:

```
Thank you for your message. Streamix is a general-purpose media player. It contains no channels, films, series or playlists, hosts or stores no content, has no built-in servers, and does not recommend or link to any provider. Users add a source of their own, and the app connects directly to that source. We therefore cannot see, change or remove the content you refer to. Please contact the provider or host that is serving it; they are the only party that can remove it.

If you believe the app, its listing or our website itself infringes your rights, please tell us exactly what and where (see the Copyright page, <site>/copyright) and we will review it promptly.

<publisher name>, <publisher email>
```

Then:
- Check the app and listing really are clean: search the listing text, screenshots, icon,
  keywords, demo playlist and website for the complainant's names and marks. If you find
  any, remove it today and say so in the reply.
- Do not argue the law with the store's reviewers. State the facts (no content, user
  supplied sources, demo source of Creative Commons films) and offer to adjust the listing.
- If the store has an appeal or counter-notification route, use it only with a lawyer.

## 4. "The app or listing infringes"

1. Remove or change the disputed item first (screenshot, text, logo, name). It is cheap and
   usually closes the matter.
2. Publish the corrected listing and, if the app itself needs a change, a new release.
3. Reply with what changed and when.
4. If it is about the name or icon and a real dispute remains, take legal advice before
   renaming.

## 5. Keep a log

Keep a simple table (a spreadsheet is fine): date received, who sent it, which store or
channel, what they claim, what you found, what you did, date of reply, outcome. Keep it for
at least three years. It is your evidence of prompt, good-faith action.

## 6. Store policy notices

- Read the policy section cited (Google: IP, Metadata, Device and Network Abuse; Apple:
  5.2.1 to 5.2.3, 2.3).
- Fix the metadata or the app, resubmit, and explain the fix in the reply.
- Use the ready replies in [app-store.md](app-store.md) (5.2.3) and the app-access notes in
  [google-play.md](google-play.md).

## 7. Keep the listing safe, always

- Never use "free TV", "all channels", "sports", "live matches", brand or channel names,
  provider names or "IPTV subscription" in metadata or screenshots.
- Never provide, recommend, sell or link to a provider, playlist or source, in the app, the
  site, the store text or support replies.
- Keep the first-run rights confirmation and the Terms/Copyright pages live.
- Keep the demo playlist to Creative Commons works only, with their licences stated.
- If a user writes for help finding sources, reply that the app does not provide any.

## 8. When a store removes the app

1. Do not create a second listing to evade it; that is a policy violation by itself.
2. Read the reason, fix the cause and appeal through the store's process.
3. Tell users through the website. Existing installs keep working because nothing in the
   app depends on the stores.
4. Take legal advice before any counter-notification.
