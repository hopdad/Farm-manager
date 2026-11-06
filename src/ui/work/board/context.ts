'use client';
/**
 * The page's board store in React (WorkBoardProvider provides it; WorkBoard, the cards, the
 * chips tray and the detail read it).
 */
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createBoardApi } from './api';
import { type BoardState, type BoardStore, createBoardStore } from './board-store';

export const BoardStoreContext = createContext<BoardStore | null>(null);

/** Outside a provider (a component rendered on its own): one store per tab. */
let fallbackStore: BoardStore | null = null;
function fallback(): BoardStore {
  fallbackStore ??= createBoardStore({ api: createBoardApi((i, init) => fetch(i, init)) });
  return fallbackStore;
}

/** The page's board store (WorkBoardProvider's). */
export function useBoardStoreApi(): BoardStore {
  return useContext(BoardStoreContext) ?? fallback();
}

/** A slice of the board store (re-renders when it changes). */
export function useBoard<T>(selector: (state: BoardState) => T): T {
  return useStore(useBoardStoreApi(), selector);
}
