import { sortMediaItems } from './sorting';
import { MediaItem } from '@/services/api';
import { describe, it, expect } from 'vitest';

describe('sortMediaItems', () => {
  const mockItems: MediaItem[] = [
    { id: 1, title: 'B Movie', year: 2020, last_watched: '2023-01-01T10:00:00Z', media_type: 'movie' },
    { id: 2, title: 'A Movie', year: 2022, last_watched: '2023-01-02T10:00:00Z', media_type: 'movie' },
    { id: 3, title: 'C Movie', year: 2021, last_watched: '2023-01-01T09:00:00Z', media_type: 'movie' },
  ];

  it('sorts by title correctly', () => {
    const sorted = sortMediaItems(mockItems, 'title');
    expect(sorted[0].title).toBe('A Movie');
    expect(sorted[1].title).toBe('B Movie');
    expect(sorted[2].title).toBe('C Movie');
  });

  it('sorts by year descending', () => {
    const sorted = sortMediaItems(mockItems, 'year');
    expect(sorted[0].year).toBe(2022);
    expect(sorted[1].year).toBe(2021);
    expect(sorted[2].year).toBe(2020);
  });

  it('sorts by recent (last_watched) descending', () => {
    const sorted = sortMediaItems(mockItems, 'recent');
    // 2023-01-02 is most recent -> A Movie
    // 2023-01-01T10:00:00Z is next -> B Movie
    // 2023-01-01T09:00:00Z is last -> C Movie
    expect(sorted[0].id).toBe(2);
    expect(sorted[1].id).toBe(1);
    expect(sorted[2].id).toBe(3);
  });

  it('handles empty array', () => {
    expect(sortMediaItems([], 'title')).toEqual([]);
  });

  it('handles missing data gracefully', () => {
    const itemsWithMissing: MediaItem[] = [
        { id: 1, title: 'B', media_type: 'movie' }, // year undefined, last_watched undefined
        { id: 2, title: 'A', year: 2022, last_watched: '2023-01-01', media_type: 'movie' }
    ];

    // Year sort: 2022 vs undefined (0). 2022 first.
    const byYear = sortMediaItems(itemsWithMissing, 'year');
    expect(byYear[0].id).toBe(2);
    expect(byYear[1].id).toBe(1);

    // Recent sort: 2023 vs undefined (0). 2023 first.
    const byRecent = sortMediaItems(itemsWithMissing, 'recent');
    expect(byRecent[0].id).toBe(2);
    expect(byRecent[1].id).toBe(1);
  });
});
