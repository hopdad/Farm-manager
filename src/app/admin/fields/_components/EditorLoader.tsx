'use client';
/** Loads the map editor in the browser only (MapLibre needs window and WebGL2). */
import dynamic from 'next/dynamic';
import css from '../field-data.module.css';
import type { EditorProps } from './BoundaryEditor';

const BoundaryEditor = dynamic(() => import('./BoundaryEditor'), {
  ssr: false,
  loading: () => <div className={css.mapWrap} aria-busy="true" />,
});

export function EditorLoader(props: EditorProps) {
  return <BoundaryEditor {...props} />;
}
