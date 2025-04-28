
import { Link } from 'react-router-dom';
import { SearchInput } from '../search/SearchInput';

export function DesktopNav() {
  return (
    <header className="sticky top-0 z-10 bg-background border-b border-border">
      <div className="container mx-auto h-16 flex items-center justify-between px-4">
        <Link to="/" className="text-2xl font-bold">
          Producer Hub
        </Link>
        
        <div className="w-full max-w-md mx-4">
          <SearchInput />
        </div>
        
        <nav className="hidden md:flex items-center gap-6">
          <Link to="/" className="text-sm font-medium hover:text-primary transition-colors">
            Discover
          </Link>
          <Link to="/search" className="text-sm font-medium hover:text-primary transition-colors">
            Search
          </Link>
        </nav>
      </div>
    </header>
  );
}
