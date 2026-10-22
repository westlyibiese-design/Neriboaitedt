// Static, plain-English deploy instructions shown next to the Download
// button on a paid "code" order (Phase 5 of the Showcase/Orders build).
// Deliberately plain content, not dynamic — every raw-code Showcase
// deliverable is a static site (zip or HTML bundle, per
// docs/SUPABASE_CONTRACT.md), and these two platforms are the ones
// Westly already uses for his own Neribo deploys (see
// docs/PHASE_1_HANDOFF.md / this project's own README), so a code-only
// buyer with no prior deploy experience gets the same path Westly does.
// Nothing here reads from Firestore, Supabase, or the purchased file
// itself — it's the same two lists for every code order.

export interface DeployGuideSection {
  title: string;
  steps: string[];
}

export const DEPLOY_GUIDE: DeployGuideSection[] = [
  {
    title: "Deploy to Cloudflare Pages",
    steps: [
      "Unzip the downloaded file on your computer — you should see index.html (and, for a multi-page site, other .html/.css/.js files) at the top level.",
      "Go to the Cloudflare dashboard, open \"Workers & Pages\", and click \"Create application\" -> \"Pages\" -> \"Upload assets\".",
      "Give your project a name and drag the unzipped folder's contents onto the upload area.",
      "Click \"Deploy site\". Cloudflare gives you a live *.pages.dev link within a minute or two.",
      "Optional: in the project's \"Custom domains\" tab, add your own domain and follow Cloudflare's DNS instructions to point it at the new site.",
    ],
  },
  {
    title: "Deploy to Netlify",
    steps: [
      "Unzip the downloaded file on your computer — you should see index.html (and, for a multi-page site, other .html/.css/.js files) at the top level.",
      "Go to app.netlify.com and sign in (a free account works fine).",
      "On the \"Sites\" page, drag the unzipped folder straight onto the \"Drag and drop your site output folder here\" area.",
      "Netlify uploads and deploys it automatically — you'll get a live *.netlify.app link within a minute.",
      "Optional: open \"Domain settings\" on the new site to rename the *.netlify.app subdomain or add your own custom domain.",
    ],
  },
];
