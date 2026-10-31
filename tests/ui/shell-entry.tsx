/** Mounts the real application shell for the interface tests, including the appearance controller. */
import { createRoot } from 'react-dom/client';
import Home from '../../app/page';
import Login from '../../app/login/page';
import AppearanceSync from '../../app/components/AppearanceSync';
createRoot(document.getElementById('root')!).render(<><AppearanceSync />{location.pathname === '/login' ? <Login /> : <Home />}</>);
