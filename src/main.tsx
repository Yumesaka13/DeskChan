import { render } from 'solid-js/web';
import App from './App';
// Preflight MUST come first: it strips UA chrome (button borders/faces,
// border-style:none on divs) that otherwise corrupts the Fluent styling
import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import './styles/global.css';

const root = document.getElementById('root');
if (root) {
    render(() => <App />, root);
}
