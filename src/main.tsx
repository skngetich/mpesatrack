import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './ui/App';
import './ui/styles.css';

// Registers the service worker that precaches the app shell, SQLite WASM and
// pdf.js so the app opens and works with no network after the first visit.
registerSW({ immediate: true });

// Ask the browser not to evict our storage under disk pressure. Best effort:
// installed PWAs are usually granted this silently; the answer isn't critical
// because the Settings tab offers a one-tap SQLite backup.
void navigator.storage?.persist?.();

render(<App />, document.getElementById('app')!);
