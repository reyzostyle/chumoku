// The FAQ, in one place.
//
// It is rendered twice: as the section a person opens on the landing page, and
// as FAQPage JSON-LD in the head, which is what an answer engine quotes. Those
// were two hand-maintained copies with a comment asking whoever edits one to
// remember the other. The build generates the second from this now.
//
// Written for extraction, not for reading top to bottom. An engine lifts the
// FIRST sentence, so each answer opens with a complete answer to the question
// and everything after it is support. And written plainly: most of the people
// asking do not have English as a first language.
// Kept short on purpose: questions of about the same length, answers of one or
// two sentences, the first of which is the whole answer.
export const FAQS: { q: string; a: string }[] = [
  {
    q: 'What does Chumoku do?',
    a: 'It finds Shorts blowing up in your niche and rebuilds them for your channel: your version of the idea, an outline, then the script.',
  },
  {
    q: 'Is it free to try?',
    a: 'The daily ideas are free: ten new ones every morning. Scripts and the chat run on credits: Plus is about 30 scripts a month, Pro about 100. A script or a steal costs 3 credits, a chat message 1.',
  },
  {
    q: 'Do I need to connect YouTube?',
    a: 'No, but it gets sharper. Connected, it reads your real retention and names the second people left.',
  },
  {
    q: 'Does it work for TikTok or Reels?',
    a: 'Yes. Follow TikTok and Instagram accounts next to YouTube channels, and add your own to see what worked for you.',
  },
  {
    q: 'What does the extension do?',
    a: 'It puts Steal and Ask on every Short on YouTube. Steal turns any Short into an outline for your channel; Ask talks it through.',
  },
  {
    q: 'How does it find ideas?',
    a: 'It shows only Shorts that beat their own channel\'s usual views, each pitched as your version for free. A script costs 3 credits.',
  },
  {
    q: 'What is Chumoku brain?',
    a: 'A profile of your channel it writes from your uploads, in one click. Every idea and script after that is written for you.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes, from the billing portal. You keep access until the period you paid for ends.',
  },
];
