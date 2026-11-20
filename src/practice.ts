// Small made-up practice data. This file is run only by the practice launcher.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function seedPractice(folder: string) {
  if (process.env.LH_DEV !== '1' || path.resolve(process.env.LH_DATA_DIR || '') !== path.resolve(folder)) throw new Error('Practice data needs its own selected folder.');
  const { setAssistantName, editUser } = await import('./profile/profile.js');
  const { remember, addCommitment } = await import('./store/proactive.js');
  setAssistantName('Pebble', 'practice');
  editUser({ op: 'add', section: 'Basics', text: 'Name: Nemi Venn. These are made-up practice details.' }, { trust: 'user', source: 'practice' });
  editUser({ op: 'add', section: 'Life', text: 'Planning a club weekend near Example Lake.' }, { trust: 'user', source: 'practice' });
  remember({ kind: 'person', subject: 'Ruvo Pell', fact: 'Helps with club bookings.', source: 'practice' });
  addCommitment({ title: 'Book the club room', owner: 'user', kind: 'remind', source: 'practice' });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await seedPractice(process.argv[2]);
