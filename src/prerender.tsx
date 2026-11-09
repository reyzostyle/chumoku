// Build-time prerender entry.
//
// The app renders entirely on the client, so the document a crawler downloads
// is a head and an empty div. Crawlers that feed answer engines read raw HTML
// and do not wait for React, which meant every word of the landing page was
// invisible to them.
//
// This renders the public routes to static markup at build time. It is NOT
// server-side rendering and there is no hydration: main.tsx still uses
// createRoot, which discards whatever sits in #root and renders fresh. So the
// prerendered markup exists purely to be read before JavaScript runs, and it
// cannot desynchronise from the live app - the live app overwrites it.
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthProvider } from './contexts/AuthContext';
import { LandingPage } from './components/LandingPage';
import { PrivacyPolicy } from './components/PrivacyPolicy';
import { TermsOfService } from './components/TermsOfService';
import { BlogPost, BlogIndex } from './components/BlogPage';
import { POSTS, postsByDate } from './lib/blog';
import { FAQS } from './lib/faq';

export interface PrerenderRoute {
  path: string;
  title: string;
  description: string;
  html: string;
  /** Extra structured data for this route, replacing the shell's FAQ block. */
  jsonLd?: unknown;
  /** Sitemap hints. Defaults are fine for most pages. */
  changefreq?: string;
  priority?: string;
}

// AuthProvider is included because the landing page's sign-in form reads it.
// Its effects never run here, so the tree renders in its signed-out state,
// which is exactly what a crawler should see.
const wrap = (node: JSX.Element) =>
  renderToStaticMarkup(<AuthProvider>{node}</AuthProvider>);

export function render(): PrerenderRoute[] {
  const SITE = 'https://chumoku.co';
  const ORG = { '@id': `${SITE}/#organization` };
  const BLOG_ID = `${SITE}/blog#blog`;

  // Home > Blog > this post. A crawler arriving on a post from a search result
  // has no idea what else is on this site; the breadcrumb is what tells it, and
  // it is what search results render under the URL.
  const crumbs = (post?: { slug: string; h1: string }) => ({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Chumoku', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog` },
      ...(post
        ? [{ '@type': 'ListItem', position: 3, name: post.h1, item: `${SITE}/blog/${post.slug}` }]
        : []),
    ],
  });

  const postRoutes: PrerenderRoute[] = POSTS.map(p => ({
    path: `/blog/${p.slug}`,
    title: `${p.title} - Chumoku`,
    description: p.description,
    html: wrap(<BlogPost post={p} />),
    changefreq: 'monthly',
    priority: '0.8',
    // BlogPosting plus the page's own questions and its breadcrumb, all pointing
    // at the Organization declared in index.html. The shell's FAQPage carries
    // the LANDING page's questions, which on a post would be answers to
    // questions the page does not ask, so it is replaced here rather than
    // inherited.
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BlogPosting',
          '@id': `${SITE}/blog/${p.slug}#article`,
          headline: p.h1,
          description: p.description,
          datePublished: p.published,
          dateModified: p.updated,
          author: ORG,
          publisher: ORG,
          isPartOf: { '@id': BLOG_ID },
          mainEntityOfPage: `${SITE}/blog/${p.slug}`,
          about: 'YouTube Shorts',
        },
        {
          '@type': 'FAQPage',
          mainEntity: p.faq.map(f => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        },
        crumbs(p),
      ],
    },
  }));

  return [
    {
      // title and description here OVERWRITE the ones in index.html for this
      // route, so the pair has to be kept in step with it. They drifted once
      // already: index.html was updated for the current product and the live
      // page still served "AI toolkit for short-form content" in its title,
      // because this is the copy that actually reaches the crawler.
      // The title carries the category on purpose. Searching the brand name
      // returns a Japanese timber company, and "the shorts workspace" does not
      // tell a search result or an answer engine which industry this is - the
      // nouns that separate them are "video" and "creators". The description
      // opens "Chumoku finds the YouTube Shorts ..." for the same reason: that
      // is the sentence an answer engine lifts when asked what Chumoku is. Keep
      // it under ~155 characters, Google cut the longer one mid-sentence.
      path: '/',
      title: 'Chumoku - Steal viral ideas for your Shorts, TikToks and Reels',
      description:
        "Chumoku finds the Shorts, TikToks and Reels blowing up in your niche and turns each one into your idea, outline and script. Never wonder what to post next.",
      html: wrap(<LandingPage />),
    },
    {
      path: '/privacy',
      title: 'Privacy Policy - Chumoku',
      description:
        'How Chumoku handles your data, what the YouTube connection reads, what the Chrome extension does, and what is stored.',
      html: wrap(<PrivacyPolicy />),
    },
    {
      path: '/terms',
      title: 'Terms of Service - Chumoku',
      description: 'The terms covering use of Chumoku, billing, credits and cancellation.',
      html: wrap(<TermsOfService />),
    },
    {
      path: '/blog',
      title: 'Blog - Chumoku',
      description:
        'How short-form video actually holds people, written for the people making it. Hooks, retention curves and why Shorts get swiped.',
      html: wrap(<BlogIndex />),
      // Weekly, because this page changes every time a post is published, which
      // is the only page on the site for which that is true.
      changefreq: 'weekly',
      priority: '0.7',
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Blog',
            '@id': BLOG_ID,
            name: 'Chumoku blog',
            description:
              'How short-form video actually holds people, written for the people making it.',
            url: `${SITE}/blog`,
            publisher: ORG,
            inLanguage: 'en',
            blogPost: postsByDate().map(p => ({
              '@type': 'BlogPosting',
              '@id': `${SITE}/blog/${p.slug}#article`,
              headline: p.h1,
              description: p.description,
              datePublished: p.published,
              dateModified: p.updated,
              url: `${SITE}/blog/${p.slug}`,
            })),
          },
          crumbs(),
        ],
      },
    },
    ...postRoutes,
  ];
}


// Re-exported for scripts/prerender.mjs, which writes the FAQPage JSON-LD
// from it so the structured data cannot drift from the page.
export const faqs = FAQS;

// Same reason: the RSS feed and the llms.txt listing of the writing are both
// generated from this, newest first, so neither can list a post that does not
// exist or miss one that does.
export const posts = postsByDate();
