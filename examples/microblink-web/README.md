# BlinkID web SDK reader walkthrough

This is a separate TypeScript exercise based on the [Microblink BlinkID v7 web quickstart](https://docs.microblink.com/blinkid/v7/sdk/web/quickstart). It is unrelated to ComfyFleet's API.

1. Use Node.js 22 or newer. Run `npm ci` in this folder.
2. In the [Microblink developer portal](https://developer.microblink.com/), request a **BlinkID**, **In-browser** license for **localhost**. Copy `.env.example` to `.env.local` and replace the placeholder with that key.
3. Run `npm run dev` and open the local URL Vite prints. Press **Start document scan** and allow camera access.
4. After a successful scan, the callback shows the result on the page and destroys the scanner. Treat results as personal data; do not publish them.
5. Run `npm run build` to check TypeScript and the production bundle. `predev` and `prebuild` copy the SDK's browser resources to `/resources`, as the Microblink guide requires.

The SDK's current npm `latest` tag is version 8003.0.0, while the linked guide is for v7. This example pins v7.8.0 to match that guide. The built bundle and resource loading can be verified without a key; an actual camera scan requires the license.

If the scanner does not start, check that the license is for `localhost`, restart Vite after editing `.env.local`, and confirm `/resources` loads. A browser camera requires a secure context; `localhost` qualifies for local testing. Microblink's [resource hosting guide](https://docs.microblink.com/blinkid/v7/sdk/web/resources) explains the extra headers needed for multithreaded WASM on a deployed site.
