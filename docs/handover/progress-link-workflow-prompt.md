# Prompt for a Claude in Chrome pass: build "Check-In: Progress link" in GHL

Paste everything below the line into Claude in Chrome while signed in to HighLevel. It builds the one workflow the member progress page is waiting on (CLAUDE.md §15.7 and §15.9). Until it is published, "Text it" on the staff page and "Text me my link" on the member page write the link to the contact and nothing is sent. Copy link and PIN login work without it.

---

You are working in HighLevel, in the sub-account **BTT Bridgewater** (location id `ARCSFhJ0JlkcuzfZtyEJ`). Confirm the sub-account name in the top left before doing anything. If it is any other sub-account, stop and tell me.

**Goal:** create and publish one workflow named exactly `Check-In: Progress link`. It texts a member their progress page link whenever the contact custom field `progress_link` changes.

**What already exists, do not change it:**
- The contact custom field **Progress Link**, key `contact.progress_link`, single line text. Do not create a second one. If you cannot find it under Settings, Custom Fields, stop and tell me.
- Two published workflows built the same way, which you may open to copy the pattern from and must not edit: `Check-In: Purchase PIN setup link` and `Check-In: Kid waiver reminder`.

**Build it like this:**
1. Automation, Workflows, Create Workflow, Start from scratch. Name it `Check-In: Progress link`. Put it in the same folder as the two workflows above if they are in one.
2. Trigger: **Contact Changed**. Add a filter so it fires only when the custom field **Progress Link** changes. Name the trigger `progress_link changed`.
3. First step: **If/Else**. Condition: contact custom field **Progress Link** *is not empty* (the UI may word it "has value"). Name the branch `has a link`.
4. On the `has a link` branch add **Send SMS** with exactly this message, keeping the merge fields as written:

   ```
   Hi {{contact.first_name}}, here is your BTT Bridgewater progress page: {{contact.progress_link}}

   Save it to your home screen to check back any time.
   ```

   No exclamation points, no emoji, no dashes used as punctuation. Do not add a signature or an opt-out line beyond what the account adds by itself.
5. Leave the other branch empty.
6. Workflow settings: turn **Allow re-entry** on, because the field changes again each time a link is sent. Leave every other setting as it is.
7. Save. Read the workflow back from top to bottom and check: the trigger filter names Progress Link, the If/Else tests the same field, the SMS body matches the text above character for character, re-entry is on.
8. Publish it. Reload the page and confirm it shows as published.

**Rules:**
- Do not send a test to any real contact. Do not use "Test workflow" with a member selected. If you want to check the SMS preview, use the built-in preview only.
- Do not edit, pause, publish or delete any other workflow.
- Do not create, rename or delete any custom field, tag, contact or template.
- Do not change any account, phone or notification setting.
- If a step does not look the way this prompt describes, stop and tell me what you see instead of improvising.

**When you are done, report:**
- the workflow's name and whether it is published,
- the trigger and its filter exactly as the UI shows them,
- the If/Else condition exactly as the UI shows it,
- the SMS body as saved,
- whether re-entry is on,
- anything you were unsure about or left undone.
