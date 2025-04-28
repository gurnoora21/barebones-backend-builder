
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { 
  Popover,
  PopoverContent,
  PopoverTrigger 
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTypeaheadSearch } from '@/hooks/useSearch';
import { useState, useRef } from 'react';

export function SearchInput() {
  const {
    searchQuery,
    setSearchQuery,
    data,
    isLoading,
    saveRecentSearch,
    getRecentSearches
  } = useTypeaheadSearch();

  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const recentSearches = getRecentSearches();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      saveRecentSearch(searchQuery);
      navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
      setOpen(false);
    }
  };

  const handleResultClick = (result: any, type: string) => {
    saveRecentSearch(result.name);
    setOpen(false);
    
    if (type === 'artists') {
      navigate(`/artist/${result.id}`);
    } else if (type === 'producers') {
      navigate(`/producer/${result.id}`);
    }
  };

  const handleRecentSearchClick = (query: string) => {
    setSearchQuery(query);
    navigate(`/search?q=${encodeURIComponent(query)}`);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <form onSubmit={handleSubmit} className="relative w-full">
        <PopoverTrigger asChild>
          <div className="relative w-full">
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search producers, artists..."
              className="w-full pl-9"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setOpen(true)}
            />
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          </div>
        </PopoverTrigger>
        <PopoverContent 
          className="w-[calc(100vw-2rem)] sm:w-[400px] p-0" 
          align="start"
          sideOffset={4}
        >
          <div className="p-4 max-h-[400px] overflow-y-auto">
            {isLoading ? (
              <div className="py-6 text-center">
                <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full inline-block" />
              </div>
            ) : (
              <>
                {data && searchQuery && Object.entries(data).some(([_, results]) => results.length > 0) ? (
                  <div className="space-y-4">
                    {data.producers?.length > 0 && (
                      <div>
                        <h3 className="font-medium text-sm text-muted-foreground mb-2">Producers</h3>
                        <ul className="space-y-1">
                          {data.producers.map((producer: any) => (
                            <li key={producer.id}>
                              <button
                                className="w-full text-left p-2 hover:bg-accent rounded-md text-sm flex items-center"
                                onClick={() => handleResultClick(producer, 'producers')}
                              >
                                {producer.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    
                    {data.artists?.length > 0 && (
                      <div>
                        <h3 className="font-medium text-sm text-muted-foreground mb-2">Artists</h3>
                        <ul className="space-y-1">
                          {data.artists.map((artist: any) => (
                            <li key={artist.id}>
                              <button
                                className="w-full text-left p-2 hover:bg-accent rounded-md text-sm flex items-center"
                                onClick={() => handleResultClick(artist, 'artists')}
                              >
                                {artist.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    {searchQuery ? (
                      <p className="text-center py-4 text-muted-foreground">No results found</p>
                    ) : (
                      recentSearches.length > 0 ? (
                        <div>
                          <h3 className="font-medium text-sm text-muted-foreground mb-2">Recent Searches</h3>
                          <ul className="space-y-1">
                            {recentSearches.map((query: string, index: number) => (
                              <li key={index}>
                                <button
                                  className="w-full text-left p-2 hover:bg-accent rounded-md text-sm flex items-center"
                                  onClick={() => handleRecentSearchClick(query)}
                                >
                                  <Search className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                                  {query}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="text-center py-4 text-muted-foreground">
                          Start typing to search
                        </p>
                      )
                    )}
                  </div>
                )}
                
                <div className="mt-2 pt-2 border-t">
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    className="w-full text-primary"
                    disabled={!searchQuery.trim()}
                  >
                    Search for "{searchQuery}" <Search className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </div>
        </PopoverContent>
      </form>
    </Popover>
  );
}
