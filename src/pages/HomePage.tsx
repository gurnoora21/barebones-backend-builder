
import { useState, useEffect } from 'react';
import { useStats } from '@/hooks/useStats';
import { useQuery } from '@tanstack/react-query';
import { fetchList, Producers } from '@/lib/supabase';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProducerGrid } from '@/components/producers/ProducerGrid';
import { ArtistGrid } from '@/components/artists/ArtistGrid';
import { StatsSection } from '@/components/stats/StatsSection';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  // For trending/hidden gems tabs
  const [currentTab, setCurrentTab] = useState('trending');
  
  // For pagination
  const [page, setPage] = useState(1);
  const pageSize = 12;
  
  // Fetch trending producers (sorted by creation date since popularity doesn't exist)
  const trendingProducersQuery = useQuery({
    queryKey: ['trendingProducers', page, pageSize],
    queryFn: () => fetchList<Producers>('producers', {
      page,
      pageSize,
      // Use created_at instead of popularity which doesn't exist
      orderBy: { column: 'created_at', ascending: false },
    })
  });
  
  // Fetch "hidden gems" producers (sort by name for now)
  const hiddenGemsQuery = useQuery({
    queryKey: ['hiddenGems', page, pageSize],
    queryFn: () => fetchList<Producers>('producers', {
      page,
      pageSize,
      // No filters since we don't have popularity
      orderBy: { column: 'name', ascending: true },
    }),
    enabled: currentTab === 'hidden',
  });
  
  const statsQuery = useStats();
  
  // Debug producer data
  useEffect(() => {
    if (trendingProducersQuery.data) {
      console.log('Trending Producers Data:', trendingProducersQuery.data);
      console.log('Producers count:', trendingProducersQuery.data?.data?.length || 0);
    }
    if (hiddenGemsQuery.data) {
      console.log('Hidden Gems Data:', hiddenGemsQuery.data);
      console.log('Hidden gems count:', hiddenGemsQuery.data?.data?.length || 0);
    }
    if (trendingProducersQuery.error) {
      console.error('Trending Producers Error:', trendingProducersQuery.error);
    }
    if (hiddenGemsQuery.error) {
      console.error('Hidden Gems Error:', hiddenGemsQuery.error);
    }
  }, [trendingProducersQuery.data, hiddenGemsQuery.data, trendingProducersQuery.error, hiddenGemsQuery.error]);
  
  return (
    <div className="space-y-12">
      <section className="text-center px-4">
        <h1 className="text-4xl font-bold tracking-tight">
          Discover Music Producers
        </h1>
        <p className="mt-4 text-xl text-muted-foreground max-w-2xl mx-auto">
          Explore the talent behind your favorite music. From chart-toppers to hidden gems.
        </p>
      </section>
      
      <StatsSection />
      
      <section className="mt-16">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold">Discover Producers</h2>
          <Tabs value={currentTab} onValueChange={setCurrentTab}>
            <TabsList>
              <TabsTrigger value="trending">Trending</TabsTrigger>
              <TabsTrigger value="hidden">Hidden Gems</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        
        <Tabs value={currentTab} className="mt-0">
          <TabsContent value="trending">
            {trendingProducersQuery.isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {Array(pageSize).fill(0).map((_, i) => (
                  <div key={i} className="h-48 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            ) : trendingProducersQuery.error ? (
              <div className="text-center py-8 text-red-500">
                Error loading producers: {(trendingProducersQuery.error as Error)?.message || 'Unknown error'}
              </div>
            ) : !trendingProducersQuery.data?.data?.length ? (
              <div className="text-center py-8">
                No producers found. Try adjusting your filters.
              </div>
            ) : (
              <ProducerGrid 
                producers={(trendingProducersQuery.data?.data || []) as Producers[]} 
              />
            )}
          </TabsContent>
          
          <TabsContent value="hidden">
            {hiddenGemsQuery.isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {Array(pageSize).fill(0).map((_, i) => (
                  <div key={i} className="h-48 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            ) : hiddenGemsQuery.error ? (
              <div className="text-center py-8 text-red-500">
                Error loading producers: {(hiddenGemsQuery.error as Error)?.message || 'Unknown error'}
              </div>
            ) : !hiddenGemsQuery.data?.data?.length ? (
              <div className="text-center py-8">
                No hidden gems found. Try adjusting your filters.
              </div>
            ) : (
              <ProducerGrid 
                producers={(hiddenGemsQuery.data?.data || []) as Producers[]}
              />
            )}
          </TabsContent>
        </Tabs>
        
        <div className="mt-8 flex justify-center">
          <Button 
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            variant="outline"
            className="mr-2"
          >
            Previous
          </Button>
          <Button
            onClick={() => setPage(p => p + 1)}
            disabled={
              (currentTab === 'trending' && !trendingProducersQuery.data?.data?.length) ||
              (currentTab === 'hidden' && !hiddenGemsQuery.data?.data?.length)
            }
            variant="outline"
          >
            Next
          </Button>
        </div>
      </section>
      
      <section className="mt-16">
        <h2 className="text-2xl font-bold mb-6">Popular Artists</h2>
        <ArtistGrid />
      </section>
    </div>
  );
}
