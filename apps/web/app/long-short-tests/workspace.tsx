'use client';
import { useState } from 'react';
import DirectionalTests from './directional-tests';
import ShortV6Tests from './short-v6';
export default function DirectionWorkspace() {
  const [archive, setArchive] = useState(false);
  return (
    <>
      <div className="strategy-tabs" role="group" aria-label="Directional research version">
        <button
          aria-pressed={!archive}
          className={!archive ? 'selected' : ''}
          onClick={() => setArchive(false)}
        >
          Latest V6 research · V1–V6
        </button>
        <button
          aria-pressed={archive}
          className={archive ? 'selected' : ''}
          onClick={() => setArchive(true)}
        >
          Original V1–V5 comparison
        </button>
      </div>
      {archive ? <DirectionalTests /> : <ShortV6Tests />}
    </>
  );
}
