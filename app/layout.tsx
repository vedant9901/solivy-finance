import './globals.css';
import './theme.css';
import BackgroundSync from './components/BackgroundSync';
import AppearanceSync from './components/AppearanceSync';
export const metadata={title:'SOLIVY Finance',description:'Professional local-first finance management',icons:{icon:'/favicon.ico',apple:'/solivy-logo.png'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><AppearanceSync/><BackgroundSync/>{children}</body></html>}
