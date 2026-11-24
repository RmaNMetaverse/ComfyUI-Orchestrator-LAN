import { createBlinkId } from '@microblink/blinkid';

const button = document.querySelector<HTMLButtonElement>('#scan')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const output = document.querySelector<HTMLPreElement>('#result')!;

button.addEventListener('click', async () => {
  const licenseKey = import.meta.env.VITE_LICENSE_KEY;
  if (!licenseKey) {
    status.textContent = 'Set VITE_LICENSE_KEY in .env.local, then restart the dev server.';
    return;
  }

  button.disabled = true;
  status.textContent = 'Starting BlinkID…';
  try {
    const blinkid = await createBlinkId({ licenseKey });
    status.textContent = 'Scanner ready. Follow the camera instructions.';
    blinkid.addOnResultCallback((result) => {
      output.textContent = JSON.stringify(result, null, 2);
      status.textContent = 'Scan complete. Result shown locally below.';
      void blinkid.destroy();
      button.disabled = false;
    });
  } catch (error) {
    status.textContent = `Could not start scanner: ${error instanceof Error ? error.message : String(error)}`;
    button.disabled = false;
  }
});
