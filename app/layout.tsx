import './globals.css';
export const metadata={title:'SOLIVY Finance',description:'Professional local-first finance management',icons:{icon:'/favicon.ico',apple:'/solivy-logo.png'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
