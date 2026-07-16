# DevourMC Store

Static DevourMC webstore.

## Contact form setup

This project is a static HTML site, so the support form uses Web3Forms from the browser. The provided Web3Forms access key is configured in `webstore.config.js` as `web3FormsAccessKey`. If you replace the form later, update that value and complete any email verification Web3Forms requires.

The form only shows success after `https://api.web3forms.com/submit` returns a successful JSON response. SMTP passwords, Gmail passwords, Votifier secrets, plugin tokens, and private API keys must never be placed in this static frontend.

## Image folders

- `images/rank-kits/` contains one kit preview image per rank.
- `images/crates/` contains one preview image per crate.
- `images/credit-shop/` contains the credit shop gallery images.
- `images/vote-sites/` contains voting-site icons.

Replace placeholder files with the final images or update the matching data arrays in `index.html`.

## Vote integration

The current website is link-based only. Live recent voters, top voters, cooldowns, or per-player vote status require a secure backend or server-side bridge connected to a real VotingPlugin/NuVotifier data source. The browser must not connect directly to Votifier or expose vote/plugin secrets.

## Local run and deployment

No build step is required. Open `index.html` directly or serve the folder with any static host. Deploy by uploading `index.html`, `webstore.config.js`, the logo files, and the `images/` folder to your static hosting provider.
