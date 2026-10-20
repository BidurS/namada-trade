import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { App, preloadView } from './app/App';
import { installRewindFetch } from './app/replay';
import { getLocation, matchPath, startRouter } from './app/router';
import { startTheme } from './app/theme';

// Order: theme (the inline script in index.html already set it), the one fetch wrapper that adds
// ?at= while rewound, the router (normalises the URL with replaceState), then the landing screen's
// code. When the server put readable text in #root (every indexed page), React renders once that code
// is in (at most 3 s): the text stays on screen until the page itself replaces it, never a skeleton
// without a heading. With an empty #root (Settings, development) the shell renders at once.
startTheme();
installRewindFetch();
startRouter();
const loc = getLocation();
const root = document.getElementById('root')!;

function render() {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
const landing = preloadView(matchPath(loc.path, loc.search).view);
if (root.firstElementChild) landing.then(render, render);
else render();
