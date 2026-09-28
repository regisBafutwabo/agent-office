import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNowPlaying } from './music.js';

test('reads the song Spotify or Apple Music is playing', () => {
  assert.deepEqual(parseNowPlaying('{"source":"spotify","title":" Buttons ","artist":"DDG","album":"Hit"}'),
    { source: 'spotify', title: 'Buttons', artist: 'DDG', album: 'Hit' });
  assert.equal(parseNowPlaying('{"source":"music","title":"x","artist":null}').artist, '');
  assert.equal(parseNowPlaying('{"source":"music","title":"' + 'a'.repeat(300) + '"}').title.length, 120);
});

test('nothing playing, an unknown app or garbage means no song', () => {
  assert.equal(parseNowPlaying(''), null);
  assert.equal(parseNowPlaying('{"source":"spotify","title":""}'), null);
  assert.equal(parseNowPlaying('{"source":"winamp","title":"x"}'), null);
  assert.equal(parseNowPlaying('not json'), null);
});
