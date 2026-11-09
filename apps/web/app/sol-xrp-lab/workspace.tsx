'use client';
import { useState } from 'react';
import SpecialistTests from './specialist-tests';
import SpecialistV5Tests from './specialist-v5';
export default function SpecialistWorkspace() {
  const [archive, setArchive] = useState(false);
  return (
    <>
      <div className="strategy-tabs" role="group" aria-label="Research version">
        <button
          type="button"
          aria-pressed={!archive}
          className={!archive ? 'selected' : ''}
          onClick={() => setArchive(false)}
        >
          Latest v5 research · V1–V5
        </button>
        <button
          type="button"
          aria-pressed={archive}
          className={archive ? 'selected' : ''}
          onClick={() => setArchive(true)}
        >
          V4 research archive
        </button>
      </div>
      {archive ? <SpecialistTests /> : <SpecialistV5Tests />}
    </>
  );
}
