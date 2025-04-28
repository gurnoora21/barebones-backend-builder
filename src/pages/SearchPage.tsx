
import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSearch } from '@/hooks/useSearch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProducerGrid } from '@/components/producers/ProducerGrid';
import { ArtistGrid } from '@/components/artists/ArtistGrid';
import { Search as SearchIcon } from 'lucide-react';

export default function SearchPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryParams = new URLSearchParams(location.search);
  const initialQuery = queryParams.get('q') || '';
  const initialType = (queryParams.get('type') || 'all') as 'all' | 'artists' | 'producers';
  
  const [searchType, setSearchType] = useState<'all' | 'artists' | 'producers'>(initialType);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  
  const {
    searchQuery,
    setSearchQuery,
    data: searchResults,
    isLoading
  } = useSearch(initialQuery, {
    type: searchType === 'all' ? undefined : searchType,
    debounceMs: 300,
    limit: pageSize,
  });
  
  useEffect(() => {
    // Update URL when search changes
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (searchType !== 'all') params.set('type', searchType);
    
    navigate(`/search?${params.toString()}`, { replace: true });
  }, [searchQuery, searchType, navigate]);
  
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // URL is already updated via useEffect
  };
  
  // Extract artists and producers from results for specific tabs
  const getFilteredResults = () => {
    if (!searchResults?.data) return [];
    
    if (searchType === 'artists') {
      return searchResults.data.filter((item: any) => item.followers !== undefined);
    } else if (searchType === 'producers') {
      return searchResults.data.filter((item: any) => item.normalized_name !== undefined);
    }
    
    return searchResults.data;
  };
  
  const filteredResults = getFilteredResults();
  
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold mb-4">Search</h1>
        
        <form onSubmit={handleSearch} className="flex w-full max-w-lg mb-6">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search for producers, artists..."
              className="pl-10"
            />
          </div>
          <Button type="submit" className="ml-2">Search</Button>
        </form>
        
        <Tabs value={searchType} onValueChange={(v: any) => setSearchType(v)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="producers">Producers</TabsTrigger>
            <TabsTrigger value="artists">Artists</TabsTrigger>
          </TabsList>
          
          {searchQuery ? (
            <>
              <TabsContent value="all" className="mt-6">
                {isLoading ? (
                  <div className="text-center py-8">
                    <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full inline-block"></div>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {searchResults?.data && (
                      <>
                        {searchResults.data.length === 0 ? (
                          <div className="text-center py-8">
                            <p className="text-muted-foreground">No results found for "{searchQuery}"</p>
                          </div>
                        ) : (
                          <>
                            <section>
                              <h2 className="text-xl font-semibold mb-4">Producers</h2>
                              <ProducerGrid 
                                producers={searchResults.data.filter((item: any) => item.normalized_name !== undefined)} 
                              />
                            </section>
                            
                            <section>
                              <h2 className="text-xl font-semibold mb-4">Artists</h2>
                              {/* Fixed props - not passing artists as a prop */}
                              <ArtistGrid 
                                artists={searchResults.data.filter((item: any) => item.followers !== undefined)} 
                              />
                            </section>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </TabsContent>
              
              <TabsContent value="producers" className="mt-6">
                {isLoading ? (
                  <div className="text-center py-8">
                    <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full inline-block"></div>
                  </div>
                ) : (
                  <div>
                    <ProducerGrid 
                      producers={filteredResults} 
                      isLoading={isLoading} 
                    />
                  </div>
                )}
              </TabsContent>
              
              <TabsContent value="artists" className="mt-6">
                {isLoading ? (
                  <div className="text-center py-8">
                    <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full inline-block"></div>
                  </div>
                ) : (
                  <ArtistGrid artists={filteredResults} />
                )}
              </TabsContent>
            </>
          ) : (
            <div className="text-center py-12">
              <p className="text-muted-foreground">Enter a search term to find producers and artists</p>
            </div>
          )}
        </Tabs>
      </section>
    </div>
  );
}
