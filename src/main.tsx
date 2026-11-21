import { render } from 'solid-js/web';
import App from './App';
// Preflight MUST come first: it strips UA chrome (button borders/faces,
// border-style:none on divs) that otherwise corrupts the Fluent styling
import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import './styles/global.css';
import './styles/fluent-tokens.css';
import './styles/desktop.css';
import './styles/fluent.css';

const root = document.getElementById('root');
if (root) {
    render(() => <App />, root);
}
