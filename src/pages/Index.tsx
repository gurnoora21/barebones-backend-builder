
import React, { useState } from 'react';
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

const Index = () => {
  const [artistId, setArtistId] = useState('');
  const [artistName, setArtistName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!artistId && !artistName) {
      toast.error('Please enter either an Artist ID or Artist Name');
      return;
    }
    
    setLoading(true);
    
    try {
      // Enqueue a message in the artist discovery queue
      const { data, error } = await supabase.rpc('pgmq_send', {
        queue_name: 'artist_discovery',
        msg: {
          artistId: artistId || undefined,
          artistName: artistName || undefined
        }
      });
      
      if (error) throw error;
      
      toast.success(
        'Job enqueued successfully!', 
        { description: `Message ID: ${data}` }
      );
      
    } catch (error) {
      console.error('Error enqueueing job:', error);
      toast.error('Failed to enqueue job', { 
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Music Discovery Pipeline</CardTitle>
            <CardDescription>
              Add an artist to discover their albums, tracks, and producers with our PGMQ-powered pipeline
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="artistId">Spotify Artist ID</Label>
                    <Input
                      id="artistId"
                      placeholder="e.g., 3TVXtAsR1Inumwj472S9r4 (for Drake)"
                      value={artistId}
                      onChange={(e) => setArtistId(e.target.value)}
                    />
                    <p className="text-sm text-gray-500">
                      OR
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="artistName">Artist Name</Label>
                    <Input
                      id="artistName"
                      placeholder="e.g., Drake"
                      value={artistName}
                      onChange={(e) => setArtistName(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              
              <Separator />
              
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Processing...' : 'Start Discovery Pipeline'}
              </Button>
            </form>
            
            <div className="mt-6">
              <h3 className="font-medium mb-2">How it works:</h3>
              <ol className="list-decimal pl-5 space-y-1 text-sm">
                <li>Enter a Spotify Artist ID or name to start the pipeline</li>
                <li>Our system will discover the artist's albums</li>
                <li>For each album, we'll extract all tracks</li>
                <li>From each track, we'll identify producers and collaborators</li>
                <li>Finally, we'll enrich with social profiles for each producer</li>
              </ol>
              <p className="text-xs text-gray-500 mt-4">
                All processing happens asynchronously via PGMQ message queues and Supabase Edge Functions
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Index;
