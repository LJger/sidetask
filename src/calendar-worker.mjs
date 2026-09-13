import { projectRecurrences } from './calendar.mjs';
self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, previews: projectRecurrences(data.tasks, data.start, data.end, data.today) }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
