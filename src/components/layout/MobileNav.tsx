
import { Link, useLocation } from 'react-router-dom';
import { Search, Home } from 'lucide-react';

export function MobileNav() {
  const location = useLocation();
  
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-10 bg-background border-t border-border h-16">
      <div className="container mx-auto h-full flex items-center justify-around">
        <Link 
          to="/" 
          className={`flex flex-col items-center justify-center w-24 h-full ${
            location.pathname === '/' ? 'text-primary' : 'text-foreground'
          }`}
        >
          <Home size={24} />
          <span className="text-xs mt-1">Home</span>
        </Link>
        
        <Link 
          to="/search"
          className={`flex flex-col items-center justify-center w-24 h-full ${
            location.pathname === '/search' ? 'text-primary' : 'text-foreground'
          }`}
        >
          <Search size={24} />
          <span className="text-xs mt-1">Search</span>
        </Link>
      </div>
    </nav>
  );
}
