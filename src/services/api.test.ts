import { describe, it, expect } from 'vitest';
import { getVideasyUrl } from './api';

describe('getVideasyUrl', () => {
    it('should construct a valid movie URL', () => {
        const url = getVideasyUrl('12345', 'movie');
        expect(url).toContain('/movie/12345');
        expect(url).toContain('overlay=true');
    });

    it('should construct a valid TV URL', () => {
        const url = getVideasyUrl('12345', 'tv', 1, 2);
        expect(url).toContain('/tv/12345/1/2');
        expect(url).toContain('nextEpisode=true');
    });

    it('should fail securely when parameters contain special characters', () => {
        const maliciousColor = 'blue&malicious=true';
        const url = getVideasyUrl('12345', 'movie', undefined, undefined, { color: maliciousColor });

        // We expect it to be encoded now
        // blue&malicious=true -> blue%26malicious%3Dtrue
        expect(url).toContain('color=blue%26malicious%3Dtrue');
        expect(url).not.toContain('color=blue&malicious=true');
    });

    it('should handle special characters in tmdbId', () => {
      // tmdbId is treated as a path component, so it should be encoded
      const maliciousId = '12345/../67890';
      const url = getVideasyUrl(maliciousId, 'movie');

      // Expected behavior: /movie/12345%2F..%2F67890
      expect(url).toContain('/movie/12345%2F..%2F67890');
      expect(url).not.toContain('/movie/12345/../67890');
    });
});
