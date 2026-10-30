import { createRoot } from 'react-dom/client';
import ReportsHub from '../../app/components/ReportsHub';
import DocumentTemplatesPanel from '../../app/components/DocumentTemplatesPanel';
const which = location.hash.replace('#', '');
createRoot(document.getElementById('root')!).render(which === 'templates' ? <DocumentTemplatesPanel /> : <ReportsHub legacy={<div id="legacy-mis">Legacy MIS view</div>} />);
