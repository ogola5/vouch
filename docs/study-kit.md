# Study kit: five real people in one evening

For W7. Each session takes about 12 minutes. The questions, consent and storage are built into
the console (study mode). This page is everything around them: setup, what to say, what not to
say, and how to report.

## Before anyone arrives (5 minutes, once)

```bash
npm run dev:fresh
```

Then open **http://localhost:4030/?presenter=1** in Chrome or Edge.
- Turn on **Read replies aloud** in the chat panel, so voice is part of the experience.
- If Bedrock is still blocked, the chat is off. That's fine. Every tour step works without it
  ("these buttons act as the agent directly through the same gate").

**Between people:** run `npm run dev:fresh` again, so each person starts from the same household.
The answers are safe: they live in their own file, `packages/mcp-server/study.db`, which
`dev:fresh` does not delete and git never commits. The startup log confirms it ("study answers …
kept across dev:fresh").

## Who to ask

Five to eight people who **share a household and buy everyday things online**. Mix ages, and
include at least one person who isn't technical. Don't use teammates or other hackathon entrants:
they know too much to be a fair test.

**Message to send:**
> I'm testing a prototype for a hackathon: a way to let a shopping assistant restock things like
> detergent, but on your terms. It takes about 12 minutes, there are no right answers, and your
> answers stay on my laptop under a code, not your name. Could you try it this week?

## The session

1. **Consent (1 minute).** Click **Run a study session** at the top of the tour. Let them read the
   consent text themselves and tick the box. Don't summarise it for them.
2. **Trust before.** They answer "would you leave it switched on?" on 1–5. Say nothing about Vouch
   first; the "before" score has to be uncoloured.
3. **The tour (7 minutes).** Say only: *"Go through the seven steps at your own pace. Think out
   loud if you like."* Then **stop talking.**
   - If they're stuck for more than about 20 seconds, point at the step's main button. Nothing else.
   - **Don't explain** why it stopped, what the gate is, or what "corroborated" means. Whether the
     product explains itself is exactly what's being measured.
4. **"Why didn't it buy Brand C?"** It appears by itself after step 4. They type in their own
   words. Don't rephrase the question.
5. **Trust after, the cost question, and a comment.** These appear after step 6.
6. **Afterwards (2 minutes, optional):** ask *"What would make you switch it off?"* and write down
   their words exactly.

## What not to do

- Don't say "trust layer", "mandate", "gate" or "MCP" before or during the session.
- Don't react to their answers, good or bad.
- Don't retry a session that went badly. Report it as it happened.

## Reporting (what goes in SUBMISSION.md)

Open **Demo → Study results** and click **Export answers (CSV)**. Report exactly:
- **n**, and who they were in one line (e.g. "6 people, ages 24–58, 2 non-technical, all from
  shared households").
- **Median trust before → after**, and how many went up or down.
- **Median cost ratio**, and how many were at or above the ~4.1 break-even.
- **How many explained the Brand C stop correctly, in their own words.** Read every answer
  yourself; the console's keyword flag is only a hint.
- **Two or three direct quotes,** including the most critical one.

Say plainly that this was a small, informal session, not a controlled study. **If fewer people
took part than planned, report the real number. Never round it up.**
