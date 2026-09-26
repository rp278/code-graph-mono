import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';

async function request(path) {
  const res = await fetch(`https://api.example.com${path}`);
  return res.json();
}

export async function fetchWidgets() {
  return request('/api/widgets');
}

export function WidgetList() {
  const [widgets, setWidgets] = useState([]);
  useEffect(() => {
    fetchWidgets().then(setWidgets);
  }, []);
  return (
    <ul>
      {widgets.map((w) => (
        <li key={w.id}>{w.name}</li>
      ))}
    </ul>
  );
}

export function WidgetDetail() {
  const [widget, setWidget] = useState(null);
  useEffect(() => {
    fetch(`/api/widgets/42`).then((r) => r.json()).then(setWidget);
  }, []);
  if (!widget) return <p>loading</p>;
  return <h1>{widget.name}</h1>;
}

export function NotFound() {
  return <p>not found</p>;
}

export function App() {
  return (
    <Routes>
      <Route path="/widgets" element={<WidgetList />} />
      <Route path="/widgets/:id" element={<WidgetDetail />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
