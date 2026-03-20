const { useState, useCallback, useMemo, useRef } = React;

// ─── Parsers ────────────────────────────────────────────────────────────────

function parseCrashLog(text) {
  const lines = text.split('\n');
  const crashes = [];
  let current = null;

  for (const line of lines) {
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
    if (/\b(FATAL|CRASH|Exception|Error|SIGSEGV|SIGABRT|panic|Traceback)\b/i.test(line)) {
      current = {
        timestamp: tsMatch ? tsMatch[1] : null,
        type: (line.match(/\b(FATAL|CRASH|SIGSEGV|SIGABRT|panic|Exception|Error)\b/i) || ['Unknown'])[0],
        message: line.trim(),
        stack: [],
      };
      crashes.push(current);
    } else if (current && /^\s+(at |#\d|frame|0x|\.\.\.)/.test(line)) {
      current.stack.push(line.trim());
    } else if (current && line.trim() === '') {
      current = null;
    }
  }
  return crashes;
}

function parseSystemLog(text) {
  const lines = text.split('\n');
  const entries = [];
  const severityCounts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };

  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}[^\s]*)\s+\[?(ERROR|WARN|WARNING|INFO|DEBUG)\]?\s*(.*)/i);
    if (match) {
      const severity = match[2].toUpperCase().startsWith('WARN') ? 'WARN' : match[2].toUpperCase();
      if (severityCounts[severity] !== undefined) severityCounts[severity]++;
      entries.push({ timestamp: match[1], severity, message: match[3].trim() });
    }
  }
  return { entries, severityCounts, total: entries.length };
}

function parseMemoryLog(text) {
  const lines = text.split('\n');
  const dataPoints = [];
  let peakUsage = 0;

  for (const line of lines) {
    const match = line.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})[^\d]*(\d+(?:\.\d+)?)\s*(MB|GB|KB|bytes)/i);
    if (match) {
      let valueMB = parseFloat(match[2]);
      const unit = match[3].toUpperCase();
      if (unit === 'GB') valueMB *= 1024;
      else if (unit === 'KB') valueMB /= 1024;
      else if (unit === 'BYTES') valueMB /= (1024 * 1024);
      if (valueMB > peakUsage) peakUsage = valueMB;
      dataPoints.push({ timestamp: match[1], valueMB });
    }
  }

  const oomEvents = (text.match(/\b(OOM|OutOfMemory|out of memory|oom-killer)\b/gi) || []).length;
  return { dataPoints, peakUsage: Math.round(peakUsage), oomEvents };
}

function parseNetworkLog(text) {
  const lines = text.split('\n');
  const errors = [];
  let timeouts = 0;
  let connectionRefused = 0;
  let dnsFailures = 0;

  for (const line of lines) {
    if (/timeout/i.test(line)) timeouts++;
    if (/connection refused/i.test(line)) connectionRefused++;
    if (/dns|resolve|NXDOMAIN/i.test(line)) dnsFailures++;
    if (/\b(error|fail|timeout|refused|unreachable)\b/i.test(line)) {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
      errors.push({ timestamp: tsMatch ? tsMatch[1] : null, message: line.trim().slice(0, 200) });
    }
  }
  return { errors: errors.slice(0, 100), timeouts, connectionRefused, dnsFailures };
}

function parseGenericLog(text) {
  const lines = text.split('\n').filter(l => l.trim());
  let errors = 0, warnings = 0;
  const errorLines = [];

  for (const line of lines) {
    if (/\berror\b/i.test(line)) { errors++; errorLines.push(line.trim().slice(0, 200)); }
    if (/\bwarn(ing)?\b/i.test(line)) warnings++;
  }
  return { totalLines: lines.length, errors, warnings, sampleErrors: errorLines.slice(0, 20) };
}

function classifyFile(name, content) {
  const lower = name.toLowerCase();
  if (/crash|fatal|panic|dump/i.test(lower)) return 'crash';
  if (/memory|mem|heap|oom/i.test(lower)) return 'memory';
  if (/network|net|conn|http/i.test(lower)) return 'network';
  if (/\b(FATAL|CRASH|SIGSEGV|SIGABRT|panic)\b/i.test(content.slice(0, 2000))) return 'crash';
  if (/\b(OOM|OutOfMemory|heap)\b/i.test(content.slice(0, 2000))) return 'memory';
  if (/system|syslog|main/i.test(lower)) return 'system';
  return 'generic';
}

async function processZip(file) {
  const zip = await JSZip.loadAsync(file);
  const results = [];

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!/\.(log|txt|out|err|crash|dump|trace)$/i.test(path) && !/log/i.test(path)) continue;

    try {
      const content = await entry.async('string');
      if (!content.trim()) continue;
      const type = classifyFile(path, content);
      let parsed;

      switch (type) {
        case 'crash': parsed = { type: 'crash', data: parseCrashLog(content) }; break;
        case 'system': parsed = { type: 'system', data: parseSystemLog(content) }; break;
        case 'memory': parsed = { type: 'memory', data: parseMemoryLog(content) }; break;
        case 'network': parsed = { type: 'network', data: parseNetworkLog(content) }; break;
        default: parsed = { type: 'generic', data: parseGenericLog(content) }; break;
      }

      results.push({ path, size: content.length, ...parsed });
    } catch (e) {
      results.push({ path, type: 'error', data: { error: e.message } });
    }
  }
  return results;
}

async function processSingleFile(file) {
  const content = await file.text();
  if (!content.trim()) return [];
  const type = classifyFile(file.name, content);
  let parsed;
  switch (type) {
    case 'crash': parsed = { type: 'crash', data: parseCrashLog(content) }; break;
    case 'system': parsed = { type: 'system', data: parseSystemLog(content) }; break;
    case 'memory': parsed = { type: 'memory', data: parseMemoryLog(content) }; break;
    case 'network': parsed = { type: 'network', data: parseNetworkLog(content) }; break;
    default: parsed = { type: 'generic', data: parseGenericLog(content) }; break;
  }
  return [{ path: file.name, size: content.length, ...parsed }];
}

// ─── Severity helpers ───────────────────────────────────────────────────────

function getSeverity(results) {
  const hasCrashes = results.some(r => r.type === 'crash' && r.data.length > 0);
  const hasOOM = results.some(r => r.type === 'memory' && r.data.oomEvents > 0);
  const totalErrors = results.reduce((sum, r) => {
    if (r.type === 'system') return sum + r.data.severityCounts.ERROR;
    if (r.type === 'generic') return sum + r.data.errors;
    if (r.type === 'network') return sum + r.data.errors.length;
    return sum;
  }, 0);

  if (hasCrashes || hasOOM) return { level: 'critical', color: '#ff4444', label: 'Critical' };
  if (totalErrors > 10) return { level: 'high', color: '#ff8c00', label: 'High' };
  if (totalErrors > 0) return { level: 'medium', color: '#ffd700', label: 'Medium' };
  return { level: 'low', color: '#44cc44', label: 'Low' };
}

function generateTextReport(results, severity) {
  let report = '=== D5 LOG DIAGNOSTICS REPORT ===\n';
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `Overall Severity: ${severity.label}\n`;
  report += `Files Analyzed: ${results.length}\n\n`;

  for (const r of results) {
    report += `--- ${r.path} (${r.type}) ---\n`;
    switch (r.type) {
      case 'crash':
        report += `Crashes found: ${r.data.length}\n`;
        r.data.forEach((c, i) => {
          report += `  [${i + 1}] ${c.type}: ${c.message}\n`;
          c.stack.forEach(s => { report += `       ${s}\n`; });
        });
        break;
      case 'system':
        report += `Entries: ${r.data.total} | Errors: ${r.data.severityCounts.ERROR} | Warnings: ${r.data.severityCounts.WARN}\n`;
        r.data.entries.filter(e => e.severity === 'ERROR').slice(0, 5).forEach(e => {
          report += `  ERROR ${e.timestamp}: ${e.message}\n`;
        });
        break;
      case 'memory':
        report += `Peak: ${r.data.peakUsage} MB | OOM Events: ${r.data.oomEvents} | Data points: ${r.data.dataPoints.length}\n`;
        break;
      case 'network':
        report += `Errors: ${r.data.errors.length} | Timeouts: ${r.data.timeouts} | Refused: ${r.data.connectionRefused} | DNS: ${r.data.dnsFailures}\n`;
        break;
      case 'generic':
        report += `Lines: ${r.data.totalLines} | Errors: ${r.data.errors} | Warnings: ${r.data.warnings}\n`;
        r.data.sampleErrors.slice(0, 5).forEach(e => { report += `  ${e}\n`; });
        break;
    }
    report += '\n';
  }
  return report;
}

// ─── UI Components ──────────────────────────────────────────────────────────

const styles = {
  container: { maxWidth: 960, margin: '0 auto', padding: '24px 16px' },
  header: { textAlign: 'center', marginBottom: 32 },
  title: { fontSize: 28, fontWeight: 700, color: '#fff', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#888' },
  dropzone: (active) => ({
    border: `2px dashed ${active ? '#4a9eff' : '#444'}`,
    borderRadius: 12,
    padding: 48,
    textAlign: 'center',
    cursor: 'pointer',
    background: active ? 'rgba(74,158,255,0.05)' : '#222',
    transition: 'all 0.2s',
    marginBottom: 24,
  }),
  dropText: { fontSize: 16, color: '#aaa', marginBottom: 8 },
  dropHint: { fontSize: 12, color: '#666' },
  badge: (color) => ({
    display: 'inline-block',
    padding: '4px 12px',
    borderRadius: 12,
    background: color,
    color: '#000',
    fontWeight: 700,
    fontSize: 13,
  }),
  card: {
    background: '#2a2a2e',
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
    border: '1px solid #333',
  },
  cardTitle: { fontSize: 14, fontWeight: 600, color: '#ccc', marginBottom: 8 },
  stat: { fontSize: 24, fontWeight: 700, color: '#fff' },
  statLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  statRow: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  statBox: { background: '#222', borderRadius: 8, padding: 12, minWidth: 100, flex: 1, textAlign: 'center' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #444', color: '#888', fontWeight: 600 },
  td: { padding: '6px 8px', borderBottom: '1px solid #333', color: '#ccc', wordBreak: 'break-word' },
  btn: { padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  btnPrimary: { background: '#4a9eff', color: '#fff' },
  btnSecondary: { background: '#444', color: '#ccc' },
  pre: { background: '#1a1a1e', padding: 12, borderRadius: 6, overflow: 'auto', fontSize: 12, color: '#aaa', maxHeight: 200 },
  tag: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 4, background: color + '22', color, fontSize: 11, fontWeight: 600, marginRight: 4 }),
  section: { marginBottom: 24 },
  loading: { textAlign: 'center', padding: 48, color: '#888' },
  tab: (active) => ({ padding: '8px 16px', border: 'none', borderBottom: active ? '2px solid #4a9eff' : '2px solid transparent', background: 'none', color: active ? '#fff' : '#888', cursor: 'pointer', fontWeight: 600, fontSize: 13 }),
  tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid #333', marginBottom: 16 },
};

function StatBox({ value, label }) {
  return React.createElement('div', { style: styles.statBox },
    React.createElement('div', { style: styles.stat }, value),
    React.createElement('div', { style: styles.statLabel }, label)
  );
}

function CrashCard({ file }) {
  const crashes = file.data;
  if (!crashes.length) return React.createElement('div', { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, file.path),
    React.createElement('div', { style: { color: '#888', fontSize: 13 } }, 'No crashes detected')
  );

  return React.createElement('div', { style: styles.card },
    React.createElement('div', { style: { ...styles.cardTitle, display: 'flex', justifyContent: 'space-between' } },
      React.createElement('span', null, file.path),
      React.createElement('span', { style: styles.tag('#ff4444') }, `${crashes.length} crash${crashes.length > 1 ? 'es' : ''}`)
    ),
    crashes.slice(0, 10).map((c, i) => React.createElement('div', { key: i, style: { marginBottom: 12 } },
      React.createElement('div', { style: { fontSize: 13, color: '#ff8888', fontWeight: 600 } },
        `${c.type}${c.timestamp ? ` @ ${c.timestamp}` : ''}`
      ),
      React.createElement('div', { style: { fontSize: 12, color: '#ccc', margin: '4px 0' } }, c.message),
      c.stack.length > 0 && React.createElement('pre', { style: styles.pre }, c.stack.join('\n'))
    ))
  );
}

function SystemCard({ file }) {
  const { entries, severityCounts, total } = file.data;
  return React.createElement('div', { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, file.path),
    React.createElement('div', { style: styles.statRow },
      React.createElement(StatBox, { value: total, label: 'Total' }),
      React.createElement(StatBox, { value: severityCounts.ERROR, label: 'Errors' }),
      React.createElement(StatBox, { value: severityCounts.WARN, label: 'Warnings' })
    ),
    severityCounts.ERROR > 0 && React.createElement('div', null,
      React.createElement('div', { style: { fontSize: 12, color: '#888', marginBottom: 4 } }, 'Recent errors:'),
      React.createElement('table', { style: styles.table },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: styles.th }, 'Time'),
            React.createElement('th', { style: styles.th }, 'Message')
          )
        ),
        React.createElement('tbody', null,
          entries.filter(e => e.severity === 'ERROR').slice(0, 10).map((e, i) =>
            React.createElement('tr', { key: i },
              React.createElement('td', { style: { ...styles.td, whiteSpace: 'nowrap', color: '#888' } }, e.timestamp),
              React.createElement('td', { style: styles.td }, e.message)
            )
          )
        )
      )
    )
  );
}

function MemoryCard({ file }) {
  const { peakUsage, oomEvents, dataPoints } = file.data;
  return React.createElement('div', { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, file.path),
    React.createElement('div', { style: styles.statRow },
      React.createElement(StatBox, { value: `${peakUsage} MB`, label: 'Peak Usage' }),
      React.createElement(StatBox, { value: oomEvents, label: 'OOM Events' }),
      React.createElement(StatBox, { value: dataPoints.length, label: 'Data Points' })
    ),
    oomEvents > 0 && React.createElement('div', { style: styles.tag('#ff4444') }, 'OOM Detected!')
  );
}

function NetworkCard({ file }) {
  const { errors, timeouts, connectionRefused, dnsFailures } = file.data;
  return React.createElement('div', { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, file.path),
    React.createElement('div', { style: styles.statRow },
      React.createElement(StatBox, { value: errors.length, label: 'Errors' }),
      React.createElement(StatBox, { value: timeouts, label: 'Timeouts' }),
      React.createElement(StatBox, { value: connectionRefused, label: 'Refused' }),
      React.createElement(StatBox, { value: dnsFailures, label: 'DNS Failures' })
    ),
    errors.length > 0 && React.createElement('div', null,
      React.createElement('div', { style: { fontSize: 12, color: '#888', marginBottom: 4 } }, 'Recent errors:'),
      errors.slice(0, 10).map((e, i) =>
        React.createElement('div', { key: i, style: { fontSize: 12, color: '#ccc', padding: '4px 0', borderBottom: '1px solid #333' } },
          e.timestamp && React.createElement('span', { style: { color: '#888', marginRight: 8 } }, e.timestamp),
          e.message
        )
      )
    )
  );
}

function GenericCard({ file }) {
  const { totalLines, errors, warnings, sampleErrors } = file.data;
  return React.createElement('div', { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, file.path),
    React.createElement('div', { style: styles.statRow },
      React.createElement(StatBox, { value: totalLines, label: 'Lines' }),
      React.createElement(StatBox, { value: errors, label: 'Errors' }),
      React.createElement(StatBox, { value: warnings, label: 'Warnings' })
    ),
    sampleErrors.length > 0 && React.createElement('pre', { style: styles.pre }, sampleErrors.slice(0, 5).join('\n'))
  );
}

function FileCard({ file }) {
  if (file.type === 'error') {
    return React.createElement('div', { style: styles.card },
      React.createElement('div', { style: styles.cardTitle }, file.path),
      React.createElement('div', { style: { color: '#ff8888', fontSize: 13 } }, `Parse error: ${file.data.error}`)
    );
  }
  switch (file.type) {
    case 'crash': return React.createElement(CrashCard, { file });
    case 'system': return React.createElement(SystemCard, { file });
    case 'memory': return React.createElement(MemoryCard, { file });
    case 'network': return React.createElement(NetworkCard, { file });
    default: return React.createElement(GenericCard, { file });
  }
}

function Report({ results }) {
  const [activeTab, setActiveTab] = useState('all');
  const severity = useMemo(() => getSeverity(results), [results]);

  const tabs = useMemo(() => {
    const types = ['all', ...new Set(results.map(r => r.type))];
    return types;
  }, [results]);

  const filtered = activeTab === 'all' ? results : results.filter(r => r.type === activeTab);

  const totalCrashes = results.filter(r => r.type === 'crash').reduce((s, r) => s + r.data.length, 0);
  const totalErrors = results.reduce((sum, r) => {
    if (r.type === 'system') return sum + r.data.severityCounts.ERROR;
    if (r.type === 'generic') return sum + r.data.errors;
    if (r.type === 'network') return sum + r.data.errors.length;
    return sum;
  }, 0);

  const handleExport = () => {
    const text = generateTextReport(results, severity);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `d5-diagnostics-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return React.createElement('div', null,
    // Summary bar
    React.createElement('div', { style: { ...styles.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        React.createElement('span', { style: styles.badge(severity.color) }, severity.label),
        React.createElement('span', { style: { fontSize: 14, color: '#ccc' } }, `${results.length} files analyzed`)
      ),
      React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
        React.createElement('span', { style: { fontSize: 13, color: '#888' } }, `${totalCrashes} crashes · ${totalErrors} errors`),
        React.createElement('button', { style: { ...styles.btn, ...styles.btnSecondary }, onClick: handleExport }, 'Export Report')
      )
    ),

    // Tabs
    React.createElement('div', { style: styles.tabBar },
      tabs.map(t => React.createElement('button', {
        key: t,
        style: styles.tab(activeTab === t),
        onClick: () => setActiveTab(t),
      }, t === 'all' ? `All (${results.length})` : `${t} (${results.filter(r => r.type === t).length})`))
    ),

    // Cards
    filtered.map((f, i) => React.createElement(FileCard, { key: i, file: f }))
  );
}

function App() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const handleFiles = useCallback(async (files) => {
    if (!files.length) return;
    setLoading(true);
    setError(null);
    try {
      let allResults = [];
      for (const file of files) {
        if (/\.zip$/i.test(file.name)) {
          const r = await processZip(file);
          allResults = allResults.concat(r);
        } else {
          const r = await processSingleFile(file);
          allResults = allResults.concat(r);
        }
      }
      if (allResults.length === 0) {
        setError('No log files found. Supported: .log, .txt, .out, .err, .crash, .dump, .trace');
      } else {
        setResults(allResults);
      }
    } catch (e) {
      setError(`Failed to process files: ${e.message}`);
    }
    setLoading(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragActive(false);
    handleFiles([...e.dataTransfer.files]);
  }, [handleFiles]);

  const onDragOver = useCallback((e) => { e.preventDefault(); setDragActive(true); }, []);
  const onDragLeave = useCallback(() => setDragActive(false), []);

  const onReset = useCallback(() => { setResults(null); setError(null); }, []);

  if (loading) {
    return React.createElement('div', { style: styles.container },
      React.createElement('div', { style: styles.loading },
        React.createElement('div', { style: { fontSize: 18, marginBottom: 8 } }, 'Analyzing logs...'),
        React.createElement('div', { style: { fontSize: 13 } }, 'Parsing files and detecting issues')
      )
    );
  }

  return React.createElement('div', { style: styles.container },
    React.createElement('div', { style: styles.header },
      React.createElement('div', { style: styles.title }, 'D5 Log Diagnostics'),
      React.createElement('div', { style: styles.subtitle }, 'Drop a zip or log files to analyze crashes, errors, memory, and network issues')
    ),

    !results && React.createElement('div', null,
      React.createElement('div', {
        style: styles.dropzone(dragActive),
        onDrop, onDragOver, onDragLeave,
        onClick: () => inputRef.current?.click(),
      },
        React.createElement('div', { style: styles.dropText }, dragActive ? 'Drop files here' : 'Drag & drop log files or zip archives'),
        React.createElement('div', { style: styles.dropHint }, '.zip, .log, .txt, .out, .err, .crash, .dump, .trace'),
        React.createElement('input', {
          ref: inputRef,
          type: 'file',
          multiple: true,
          accept: '.zip,.log,.txt,.out,.err,.crash,.dump,.trace',
          style: { display: 'none' },
          onChange: (e) => handleFiles([...e.target.files]),
        })
      ),
      error && React.createElement('div', { style: { color: '#ff8888', textAlign: 'center', marginTop: 12 } }, error)
    ),

    results && React.createElement('div', null,
      React.createElement('div', { style: { marginBottom: 16, textAlign: 'right' } },
        React.createElement('button', { style: { ...styles.btn, ...styles.btnSecondary }, onClick: onReset }, 'Analyze New Files')
      ),
      React.createElement(Report, { results })
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
