import { useState } from 'react';
import type { BookDetail } from '../types';
import type { Location } from '../session';

export function ReadingProgress({ book, location, seek, back }: { book: BookDetail; location: Location; seek: (ratio: number) => void; back?: () => void }) {
  const [scrub, setScrub] = useState<number | null>(null);
  const ratio = scrub ?? location.ratio;
  const commit = () => { if (scrub !== null) { seek(scrub); setScrub(null); } };
  const total = (book.sections.at(-1)?.last_block ?? 0) + 1;
  return <footer className="reading-progress">
    <span>{book.format === 'pdf' ? `p. ${location.page} of ${book.pages}` : `Location ${location.block + 1} of ${total}`}</span>
    <input type="range" aria-label="Reading position" aria-valuetext={`${Math.round(ratio*100)} percent`} title={`${Math.round(ratio*100)}%`} min={0} max={10000} value={Math.round(ratio*10000)} onChange={(e) => setScrub(Number(e.target.value)/10000)} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    <span>{Math.round(ratio*100)}%</span>
    {back && <button className="tab" onClick={back}>Go back</button>}
  </footer>;
}
