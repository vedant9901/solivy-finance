/** Mounts the real application shell for the client benchmark: #login → the login screen, otherwise the main page. */
import { createRoot } from 'react-dom/client';
import Home from '../../app/page';
import Login from '../../app/login/page';

const root = createRoot(document.getElementById('root')!);
root.render(location.pathname === '/login' ? <Login /> : <Home />);
