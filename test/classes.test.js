import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchClasses, classesOn, weekdayOf, shiftDate, validateClassChoice, UNSCHEDULED_CLASS } from '../src/classes.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const TZ = 'America/New_York';

// EDT helper: "2026-09-05 16:30" ET → Date (UTC-4). EST helper: UTC-5.
const edt = (s) => new Date(`${s}:00-04:00`);
const est = (s) => new Date(`${s}:00-05:00`);
const names = (r) => r.matches.map((m) => `${m.name}@${m.start}`);

test('weekdayOf and shiftDate are host-timezone independent', () => {
  assert.equal(weekdayOf('2026-09-05'), 'Sat');
  assert.equal(weekdayOf('2026-09-06'), 'Sun');
  assert.equal(weekdayOf('2026-09-08'), 'Tue');
  assert.equal(shiftDate('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.throws(() => weekdayOf('2026-9-5'), /bad date/);
});

test('classesOn lists the day in start order with startLocal', () => {
  const sat = classesOn(schedule, '2026-09-05');
  assert.deepEqual(sat.map((c) => c.startLocal), [
    '2026-09-05T10:30',
    '2026-09-05T11:00',
    '2026-09-05T11:45',
    '2026-09-05T13:00',
  ]);
  assert.equal(sat[0].programLabel, 'Kids 3-5');
  assert.deepEqual(classesOn(schedule, '2026-09-06'), []); // Sunday
  assert.deepEqual(classesOn(schedule, '2026-09-07'), []); // Monday
  assert.deepEqual(classesOn(schedule, '2026-09-11'), []); // Friday
});

test('window edges: 2 hours before is in, 121 minutes is out; 20 after is in, 21 is out', () => {
  // Tue Kids 3-5 at 16:00.
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-08T14:00'), TZ)), ['Kids 3-5@16:00']);
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-08T13:59'), TZ)), []);
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-08T16:20'), TZ)), ['Kids 3-5@16:00', 'Kids 6-9@16:30', 'Kids 10-14@17:15', 'Adult BJJ@18:15']);
  assert.ok(!names(matchClasses(schedule, edt('2026-09-08T16:21'), TZ)).includes('Kids 3-5@16:00'));
});

test('back-to-back kids classes both match; program tag must disambiguate', () => {
  const r = matchClasses(schedule, edt('2026-09-08T16:40'), TZ);
  assert.deepEqual(names(r), ['Kids 6-9@16:30', 'Kids 10-14@17:15', 'Adult BJJ@18:15']);
  const byProgram = (p) => r.matches.filter((m) => m.program === p).map((m) => m.name);
  assert.deepEqual(byProgram('kids-6-9'), ['Kids 6-9']);
  assert.deepEqual(byProgram('kids-10-14'), ['Kids 10-14']);
  assert.deepEqual(byProgram('adult'), ['Adult BJJ']);
  assert.deepEqual(byProgram('kids-3-5'), [], 'Kids 3-5 closed at 16:20');
  assert.equal(r.matches[0].startsInMin, -10);
  assert.equal(r.matches[1].startsInMin, 35);
});

test('member with two program tags can see two classes at once', () => {
  // Tue 17:30: Kids 10-14 (17:15, +15) and Adult BJJ (18:15, -45) both in window.
  const r = matchClasses(schedule, edt('2026-09-08T17:30'), TZ);
  const mine = r.matches.filter((m) => ['kids-10-14', 'adult'].includes(m.program)).map((m) => m.name);
  assert.deepEqual(mine, ['Kids 10-14', 'Adult BJJ']);
});

test('no class right now', () => {
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-08T12:00'), TZ)), []); // Tue noon
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-06T11:00'), TZ)), []); // Sunday
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-08T19:31'), TZ)), []); // after Adult BJJ window
});

test('Wednesday is No-Gi for adults, kids keep their names', () => {
  const r = matchClasses(schedule, edt('2026-09-09T18:00'), TZ);
  assert.deepEqual(names(r), ['Adult No-Gi@18:15']);
  assert.equal(r.weekday, 'Wed');
  const kids = matchClasses(schedule, edt('2026-09-09T16:30'), TZ);
  assert.deepEqual(names(kids), ['Kids 6-9@16:30', 'Kids 10-14@17:15', 'Adult No-Gi@18:15']);
});

test('Saturday schedule', () => {
  const r = matchClasses(schedule, edt('2026-09-05T10:50'), TZ);
  assert.deepEqual(names(r), ['Kids 3-5@10:30', 'Kids 6-9@11:00', 'Kids 10-14@11:45']);
  assert.equal(r.nowLocal, '2026-09-05T10:50');
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-05T11:00'), TZ)), ['Kids 6-9@11:00', 'Kids 10-14@11:45', 'Adult BJJ@13:00']);
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-05T08:30'), TZ)), ['Kids 3-5@10:30']);
  assert.equal(r.date, '2026-09-05');
  assert.deepEqual(names(matchClasses(schedule, edt('2026-09-05T12:30'), TZ)), ['Adult BJJ@13:00']);
});

test('DST: the week before and after fall-back both resolve 16:30 ET', () => {
  // 2026-11-01 is fall-back. Tue Oct 27 is EDT, Tue Nov 3 is EST.
  assert.deepEqual(names(matchClasses(schedule, edt('2026-10-27T16:30'), TZ)), ['Kids 6-9@16:30', 'Kids 10-14@17:15', 'Adult BJJ@18:15']);
  assert.deepEqual(names(matchClasses(schedule, est('2026-11-03T16:30'), TZ)), ['Kids 6-9@16:30', 'Kids 10-14@17:15', 'Adult BJJ@18:15']);
  // Same UTC instant on both days would be a different ET hour; the code must not assume a fixed offset.
  const nov = matchClasses(schedule, new Date('2026-11-03T20:30:00Z'), TZ); // 15:30 EST
  assert.equal(nov.nowLocal, '2026-11-03T15:30');
  assert.deepEqual(names(nov), ['Kids 3-5@16:00', 'Kids 6-9@16:30', 'Kids 10-14@17:15']);
});

test('DST: spring-forward Sunday has no classes, the following Tuesday works', () => {
  // 2026-03-08 is spring-forward.
  assert.deepEqual(names(matchClasses(schedule, new Date('2026-03-08T15:00:00Z'), TZ)), []);
  const tue = matchClasses(schedule, new Date('2026-03-10T20:30:00Z'), TZ); // 16:30 EDT
  assert.equal(tue.nowLocal, '2026-03-10T16:30');
  assert.deepEqual(names(tue), ['Kids 6-9@16:30', 'Kids 10-14@17:15', 'Adult BJJ@18:15']);
});

test('validateClassChoice accepts a real class on its day and rejects the rest', () => {
  assert.equal(validateClassChoice(schedule, 'Kids 6-9', '2026-09-05T11:00').ok, true);
  assert.equal(validateClassChoice(schedule, 'Kids 6-9', '2026-09-05T11:00').program, 'kids-6-9');
  assert.equal(validateClassChoice(schedule, 'Kids 6-9', '2026-09-08T16:30').ok, true);
  assert.match(validateClassChoice(schedule, 'Kids 6-9', '2026-09-08T11:00').error, /no such class/); // Sat time on a Tue
  assert.match(validateClassChoice(schedule, 'Adult BJJ', '2026-09-09T18:15').error, /no such class/); // Wed is No-Gi
  assert.equal(validateClassChoice(schedule, 'Adult No-Gi', '2026-09-09T18:15').ok, true);
  assert.match(validateClassChoice(schedule, 'Kids 6-9', '2026-09-05 11:00').error, /YYYY-MM-DDTHH:MM/);
  assert.match(validateClassChoice(schedule, 'Kids 6-9', '2026-02-30T11:00').error, /no such class|invalid date/);
  assert.match(validateClassChoice(schedule, 'Kids 6-9', 'x').error, /YYYY-MM-DDTHH:MM/);
});

test('validateClassChoice handles the unscheduled case', () => {
  assert.equal(validateClassChoice(schedule, UNSCHEDULED_CLASS, '2026-09-06T00:00').ok, true);
  assert.match(validateClassChoice(schedule, UNSCHEDULED_CLASS, '2026-09-06T14:00').error, /T00:00/);
});
