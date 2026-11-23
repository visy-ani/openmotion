import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GameCard } from '../../../../shared/game-contract';

/** Spreads portrait games through the list (one after every two landscape games) so the waterfall mixes both shapes. */
export function interleavePortrait(list: GameCard[]): GameCard[] {
  const portrait = list.filter(game => game.orientation === 'portrait');
  const others = list.filter(game => game.orientation !== 'portrait');
  if (!portrait.length || !others.length) return list;
  const mixed: GameCard[] = [];
  others.forEach((game, index) => {
    mixed.push(game);
    if (index % 2 === 1 && portrait.length) mixed.push(portrait.shift()!);
  });
  return [...mixed, ...portrait];
}

/**
 * Waterfall layout: landscape (16:9) and portrait (9:16) cards keep their shapes;
 * each card goes to the shortest column, in list order.
 */
export function GameMasonry({
  games,
  render,
  minColumn = 260,
  gap = 12,
  metaHeight = 0,
  className = 'om-game-masonry',
  columnClassName = 'om-game-masonry-column',
}: {
  games: GameCard[];
  render: (game: GameCard) => ReactNode;
  minColumn?: number;
  gap?: number;
  metaHeight?: number;
  className?: string;
  columnClassName?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const next = element.clientWidth;
      if (next > 0) setWidth(prev => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? element.clientWidth;
      if (next > 0) setWidth(prev => (prev === next ? prev : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = Math.max(1, Math.floor(((width || minColumn * 2) + gap) / (minColumn + gap)));
  const columns = useMemo(() => {
    const column = width ? (width - gap * (count - 1)) / count : minColumn;
    const lists: GameCard[][] = Array.from({ length: count }, () => []);
    const heights = Array(count).fill(0) as number[];
    for (const game of games) {
      const shortest = heights.indexOf(Math.min(...heights));
      lists[shortest].push(game);
      heights[shortest] += column * (game.orientation === 'portrait' ? 16 / 9 : 9 / 16) + metaHeight + gap;
    }
    return lists;
  }, [games, count, width, minColumn, gap, metaHeight]);

  return (
    <div ref={box} className={className}>
      {columns.map((list, index) => (
        <div key={index} className={columnClassName}>
          {list.map(render)}
        </div>
      ))}
    </div>
  );
}
