import { describe, expect, it, vi } from 'vitest';
import { messageOf, note, report, where } from '../src/util/report';

vi.stubGlobal('location', { pathname: '/', search: '?seed=7' });
vi.stubGlobal('navigator', { userAgent: 'test-browser' });

describe('bug report', () => {
  it('names what failed, where the game was, the error with its stack, and what went wrong just before', () => {
    where.map = 'spire-nine';
    where.seed = 7;
    note('connection closed: lost');
    const err = new Error('boom');
    const text = report('error in play', err);
    expect(text).toContain('error in play');
    expect(text).toContain('?seed=7');
    expect(text).toContain('test-browser');
    expect(text).toMatch(/map\s+spire-nine/);
    expect(text).toContain('Error: boom');
    expect(text).toContain(err.stack!.split('\n')[1]);
    expect(text).toContain('connection closed: lost');
  });

  it('keeps only the last few notes', () => {
    for (let i = 0; i < 20; i++) note(`line ${i}`);
    const text = report('x');
    expect(text).toContain('line 19');
    expect(text).not.toContain('line 5\n');
  });

  it('describes whatever was thrown', () => {
    expect(messageOf(new TypeError('bad'))).toBe('TypeError: bad');
    expect(messageOf('plain')).toBe('plain');
  });
});
