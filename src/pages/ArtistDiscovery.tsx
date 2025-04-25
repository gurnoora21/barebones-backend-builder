
import { useState } from 'react';
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export default function ArtistDiscovery() {
  const [isLoading, setIsLoading] = useState(false);

  const startDiscovery = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('artistDiscovery', {
        body: { artistName: 'Drake' }
      });
      
      if (error) throw error;
      
      toast.success('Started artist discovery for Drake');
    } catch (error) {
      console.error('Error:', error);
      toast.error('Failed to start artist discovery');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Artist Discovery</h1>
      <Button 
        onClick={startDiscovery}
        disabled={isLoading}
      >
        {isLoading ? 'Starting...' : 'Start Drake Discovery'}
      </Button>
    </div>
  );
}
