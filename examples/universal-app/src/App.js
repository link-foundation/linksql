import { createElement as h, useState } from 'react';
import { Database } from '../../../src/query.js';

const repositoryUrl =
  import.meta.env.VITE_REPOSITORY_URL ??
  'https://github.com/link-foundation/linksql';

// Canonical one-liners that exercise the single substitution operation: every
// query is `(restriction) (substitution)`, positionally paired.
const exampleQueries = [
  {
    label: 'Create',
    query: '() ((alice loves bob))',
    detail: 'An empty restriction with one substitution creates a link.',
  },
  {
    label: 'Read',
    query: '(($i: $s $t))',
    detail: 'A lone restriction with variables reads every link.',
  },
  {
    label: 'Update',
    query: '((alice loves bob)) ((alice loves carol))',
    detail: 'Pairing a match with a new shape rewrites it in place.',
  },
  {
    label: 'Delete',
    query: '((alice loves carol)) ()',
    detail: 'A trailing restriction with no substitution removes the match.',
  },
];

function createSeedDatabase() {
  const db = new Database();
  db.query('() ((alice loves bob))');
  return db;
}

function snapshot(db) {
  return { lino: db.toLino(), links: db.links() };
}

function QueryField({ value, onChange, onRun }) {
  return h(
    'label',
    { className: 'number-field', htmlFor: 'query-input' },
    h('span', null, 'LinksQL query (Links Notation)'),
    h('input', {
      id: 'query-input',
      value,
      spellCheck: false,
      autoComplete: 'off',
      onChange: (event) => onChange(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          onRun();
        }
      },
    })
  );
}

function ResultTile({ label, value, tone }) {
  return h(
    'div',
    { className: `result-tile result-tile-${tone}` },
    h('span', { className: 'result-label' }, label),
    h('strong', null, String(value))
  );
}

function LinkRow({ link }) {
  return h(
    'li',
    null,
    h('span', null, `(${link.index}: ${link.source} ${link.target})`),
    h('small', null, `source ${link.source}, target ${link.target}`)
  );
}

export function App() {
  const [db] = useState(createSeedDatabase);
  const [queryText, setQueryText] = useState('() ((alice loves bob))');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState(() => snapshot(db));

  const runQuery = () => {
    try {
      const result = db.query(queryText);
      setReport(result);
      setError('');
      setView(snapshot(db));
    } catch (failure) {
      setError(failure.message);
      setReport(null);
    }
  };

  return h(
    'main',
    { className: 'app-shell' },
    h(
      'section',
      { className: 'workspace', 'aria-labelledby': 'playground-title' },
      h(
        'div',
        { className: 'calculator-panel' },
        h('p', { className: 'eyebrow' }, 'Single substitution operation'),
        h('h1', { id: 'playground-title' }, 'LinksQL'),
        h(
          'div',
          { className: 'input-grid' },
          h(QueryField, {
            value: queryText,
            onChange: setQueryText,
            onRun: runQuery,
          })
        ),
        h(
          'div',
          { className: 'results-grid', 'aria-live': 'polite' },
          h(ResultTile, {
            label: 'Operation',
            value: error ? 'error' : (report?.operation ?? '—'),
            tone: 'green',
          }),
          h(ResultTile, {
            label: 'Links in store',
            value: view.links.length,
            tone: 'blue',
          })
        ),
        error ? h('p', { className: 'eyebrow', role: 'alert' }, error) : null,
        h(
          'ul',
          { className: 'target-list' },
          exampleQueries.map((example) =>
            h(
              'li',
              { key: example.label },
              h(
                'button',
                {
                  type: 'button',
                  className: 'download-link',
                  onClick: () => setQueryText(example.query),
                },
                `${example.label}: ${example.query}`
              ),
              h('small', null, example.detail)
            )
          )
        )
      ),
      h(
        'aside',
        { className: 'distribution-panel', 'aria-labelledby': 'store-title' },
        h('h2', { id: 'store-title' }, 'Links store'),
        h(
          'p',
          null,
          'Every query runs against an in-memory Database. Links are doublets ' +
            '— (index: source target) — deduplicated by their (source, target) pair.'
        ),
        h(
          'ul',
          { className: 'target-list' },
          view.links.length === 0
            ? h('li', null, h('span', null, 'The store is empty.'))
            : view.links.map((link) => h(LinkRow, { key: link.index, link }))
        ),
        h(
          'a',
          {
            className: 'download-link',
            href: repositoryUrl,
            target: '_blank',
            rel: 'noreferrer',
          },
          'Open the LinksQL repository'
        )
      )
    )
  );
}
