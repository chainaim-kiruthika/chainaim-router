# PrivacyBuddy by ChainAIm: business video script

Audience: business owners, operations and compliance leads. Story: a support team uses AI to answer customers without exposing customer data, and pays only for the answers it uses.

Target length 1:30 to 2:00. Voiceover is about 250 words, which is about 1:40 of speech at 150 words a minute. With the pauses for clicks and the payment loading, it fills 1:50 to 2:00; if you run long, cut the "why it matters" lines to two. One screen recording of the PrivacyBuddy page, no cuts needed.

## 0:00 to 0:18: the problem

**Screen:** title card "PrivacyBuddy by ChainAIm" for two seconds, then the page with "Spend your tokens wisely". Optional: a slide with two lines, "Customer data in prompts" and "Seats, plans and keys".

> Your team is already using AI. They paste in customer names, emails and card numbers, and you pay for seats, plans and keys to let them. That is a privacy risk and a wasted budget. PrivacyBuddy, by ChainAIm, fixes both.

## 0:18 to 0:42: protect the customer

**Screen:** paste a customer message (name, email, phone, test card number) into the box. Click **Mask**. Placeholders light up.

> Watch a support agent draft a refund reply. They paste the customer's message and click Mask. Right in the browser, the name, the email and the phone number become placeholders, and the card number is removed for good. Customer data never leaves their computer, and nothing has been spent yet.

## 0:42 to 1:05: pay per answer

**Screen:** point at **Execute · $0.01** and the two wallet chips. Click Execute. Show the network badge and balance.

> Now they click Execute. One cent, paid per answer, in USDC on Algorand. No seat licence, no monthly plan, no API key for anyone to leak. And if someone forgets to mask, the service refuses to send the text. You set the spend cap, and you pay only for the answers you use.

## 1:05 to 1:27: the answer

**Screen:** the answer appears with the real name restored; show the model and data-class pills; click the payment link and show the transaction on Lora.

> The model works on the masked text and never learns who the customer is. The agent's browser puts the real details back, so the reply is ready to send. One question, one cent, no exposure. And here is the receipt, on the public ledger.

## 1:27 to 1:47: why it matters

**Screen:** back to the page; three short text lines fade in: "Protected", "Pay per use", "Auditable".

> For a business, that is three things. Customer data protected before it leaves the browser. Spend that follows usage, not headcount. And a record for every answer that your auditors can check. Because it is built on x402, your automations and AI agents can pay and ask too, with nobody handing out keys.

## 1:47 to 1:55: close

**Screen:** the headline and the two wallet chips, then an end card "PrivacyBuddy by ChainAIm".

> PrivacyBuddy, by ChainAIm. Protect your data, pay only for answers, and spend your tokens wisely.

## Before you record

- **"Save your tokens" means saving spend.** The script says you pay a cent per answer with no seats or plans. It does not say masking shrinks your prompts, because it does not. No savings figures are invented. If you have a real comparison (for example your per-seat AI cost against cents per answer), put it on screen in the "Pay per use" line.
- Use a support-style sample message, for example: "Customer Priya Sharma (priya@example.com, 98765 43210) says her card 4111 1111 1111 1111 was charged twice. Draft a refund reply." The card number is a test number; never use a real one. Rehearse once, since name detection is the least certain part of the masker, and make sure the placeholders on screen match the voiceover.
- **"The service refuses to send the text"** describes the server check in `/api/execute` (a 400 when the text still holds a value the masker would catch; see `services/web/src/app.ts:144`). It is in the code; confirm it in the running page before you say it. You can show it: paste unmasked text, try Execute, and read the refusal.
- **"You set the spend cap"** is the `MAX_EXECUTES_PER_HOUR` setting. Keep the line only if you are showing the operator side, or change it to "the service caps spend per hour".
- **Network:** the web page is built for TestNet, so the script does not claim MainNet. If you record on MainNet, add "a real payment, on MainNet" in the pay section. Say "TestNet" if the badge says TestNet.
- The health-data routing rule (health text only to providers that do not collect it) is left out. Add it only if it is running when you record.
- The Execute step cannot be recorded for real until the buyer wallet holds USDC and the chat route is live (OpenRouter key set).
