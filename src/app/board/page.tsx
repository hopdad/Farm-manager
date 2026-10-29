/** /board: the war-room map. Placeholder until the map stage lands (WarRoomMap, fleet layer). */
export default function BoardPage() {
  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
      <div style={{ maxWidth: 560, textAlign: 'center' }}>
        <h1 style={{ fontSize: 32, margin: '0 0 8px' }}>Farm Ops board</h1>
        <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
          The war-room map arrives in the next M0 stage. The app and database are up:{' '}
          <a href="/api/health" style={{ color: '#86efac' }}>
            /api/health
          </a>
        </p>
      </div>
    </main>
  );
}
