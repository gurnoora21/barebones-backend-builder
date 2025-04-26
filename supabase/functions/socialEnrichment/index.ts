
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PageWorker } from "../lib/pageWorker.ts";
import { globalCache } from "../lib/cache.ts";

interface SocialEnrichmentMsg {
  producerName: string;
  traceContext?: any; // Will be automatically handled by the PageWorker base class
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Cache TTLs in milliseconds
const SEARCH_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// User-Agent rotation list
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36 Edg/94.0.992.47',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
];

// Search result scoring weights
const SCORE_WEIGHTS = {
  nameInUsername: 3,
  nameInTitle: 5,
  verifiedBadge: 10,
  producerInBio: 15,
  musicInBio: 8,
  artistInBio: 8,
  officialInBio: 5,
  hasExternalUrl: 3,
  followersThreshold: 2, // >1000 followers
  postsThreshold: 1,  // >10 posts
};

class SocialEnrichmentWorker extends PageWorker<SocialEnrichmentMsg> {
  constructor() {
    super('social_enrichment', 45); // Increased visibility timeout to 45 seconds
  }

  protected async process(msg: SocialEnrichmentMsg): Promise<void> {
    const { producerName } = msg;
    
    return this.traceOperation('enrichProducer', async () => {
      console.log(`Processing social enrichment for producer ${producerName}`);
      
      // Get producer from database
      const { data: producer } = await this.supabase
        .from('producers')
        .select('id, metadata, normalized_name')
        .eq('normalized_name', producerName.toLowerCase().trim())
        .single();

      if (!producer) {
        throw new Error(`Producer ${producerName} not found in database`);
      }

      // Extract roles from metadata for specialized social profile searches
      const roles = await this.traceOperation('extractRoles', async () => {
        return producer.metadata?.roles || ['producer'];
      });
      
      // Initialize social profiles object or use existing one
      const existingSocialProfiles = producer.metadata?.social_profiles || {};
      const socialProfiles = { ...existingSocialProfiles };
      
      console.log(`Enriching social profile for ${producerName} (roles: ${roles.join(', ')})`);
      
      // Find Instagram profile with the updated approach
      let instagramProfile: InstagramProfile | null = null;
      let enrichmentFailed = false;
      let extractedEmail: string | null = null;

      await this.traceOperation('findInstagramProfile', async () => {
        try {
          instagramProfile = await this.findBestInstagramProfile(producerName, roles);
          if (instagramProfile) {
            socialProfiles.instagram = instagramProfile.url;
            socialProfiles.instagram_data = {
              username: instagramProfile.username,
              full_name: instagramProfile.fullName,
              bio: instagramProfile.bio,
              external_url: instagramProfile.externalUrl,
              verified: instagramProfile.verified,
              followers: instagramProfile.followers,
              posts: instagramProfile.posts,
              confidence_score: instagramProfile.score,
            };
            
            // Extract email from bio or external URL if present
            const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g;
            const bioEmails = instagramProfile.bio.match(emailRegex);
            if (bioEmails && bioEmails.length > 0) {
              extractedEmail = bioEmails[0].toLowerCase();
            }
            
            console.log(`Found Instagram profile for ${producerName}: ${instagramProfile.url}`);
          } else {
            console.log(`No suitable Instagram profile found for ${producerName}`);
            enrichmentFailed = true;
            // Fall back to basic profile URL construction if we couldn't find a better match
            socialProfiles.instagram = `https://instagram.com/${encodeURIComponent(producerName.replace(/\s+/g, ''))}`;
          }
        } catch (error) {
          console.error(`Error finding Instagram profile for ${producerName}:`, error);
          enrichmentFailed = true;
          // Fall back to basic profile URL if there was an error in the enhanced process
          socialProfiles.instagram = `https://instagram.com/${encodeURIComponent(producerName.replace(/\s+/g, ''))}`;
        }
      });
      
      // Add other social profiles based on role
      await this.traceOperation('buildOtherSocialProfiles', async () => {
        const isPrimaryProducer = roles.includes('producer');
        const isWriter = roles.includes('writer');
        
        // Basic social profiles for all
        socialProfiles.twitter = `https://twitter.com/${encodeURIComponent(producerName)}`;
        
        // Add specialized profiles based on role
        if (isPrimaryProducer) {
          socialProfiles.soundcloud = `https://soundcloud.com/${encodeURIComponent(producerName.replace(/\s+/g, '-').toLowerCase())}`;
          socialProfiles.beatstars = `https://beatstars.com/${encodeURIComponent(producerName.replace(/\s+/g, '').toLowerCase())}`;
        }
        
        if (isWriter) {
          socialProfiles.genius = `https://genius.com/artists/${encodeURIComponent(producerName.replace(/\s+/g, '-'))}`;
          socialProfiles.ascap = `https://www.ascap.com/repertory#ace/search/writer/${encodeURIComponent(producerName)}`;
        }
      });

      // Update producer metadata with social profiles and enrichment info
      await this.traceOperation('updateProducer', async () => {
        const updateData: Record<string, any> = {
          metadata: {
            ...producer.metadata,
            social_profiles: socialProfiles,
            last_enriched: new Date().toISOString()
          },
          enriched_at: new Date().toISOString(),
          enrichment_failed: enrichmentFailed
        };

        // Only update these fields if we have a valid Instagram profile
        if (instagramProfile) {
          updateData.instagram_handle = instagramProfile.username;
          updateData.instagram_bio = instagramProfile.bio;
          if (extractedEmail) {
            updateData.email = extractedEmail;
          }
        }

        const { error: updateError } = await this.supabase
          .from('producers')
          .update(updateData)
          .eq('id', producer.id);

        if (updateError) {
          console.error('Error updating producer metadata:', updateError);
          throw updateError;
        }
      });
      
      console.log(`Completed social enrichment for ${producerName}`);
    });
  }

  // Helper function to get a random UA and create standard headers
  private getRequestHeaders(): Record<string, string> {
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    return {
      'User-Agent': randomUserAgent,
      'Accept': 'application/json',
      'Referer': 'https://www.instagram.com/'
    };
  }

  // Helper function to wait for a specified time
  private async throttleRequest(ms = 1000): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async findBestInstagramProfile(producerName: string, roles: string[]): Promise<InstagramProfile | null> {
    return this.withRetry(async () => {
      const cacheKey = `instagram_profile_${producerName.toLowerCase().replace(/\s+/g, '_')}`;
      
      // Check cache first
      const cachedProfile = globalCache.get<InstagramProfile>(cacheKey);
      if (cachedProfile) {
        console.log(`Using cached Instagram profile for ${producerName}`);
        return cachedProfile;
      }
      
      // Prepare search context based on roles
      const searchContext = roles.includes('producer') 
        ? 'music producer' 
        : roles.includes('writer') 
          ? 'songwriter' 
          : 'musician';
      
      // Find potential Instagram profiles via DuckDuckGo search
      const potentialProfiles = await this.searchInstagramProfiles(producerName, searchContext);
      
      if (potentialProfiles.length === 0) {
        console.log(`No Instagram profiles found for ${producerName} via search`);
        return null;
      }
      
      console.log(`Found ${potentialProfiles.length} potential Instagram profiles for ${producerName}`);
      
      // Fetch detailed profile info and score the profiles
      const scoredProfiles: ScoredProfile[] = [];
      
      for (const profile of potentialProfiles.slice(0, 3)) { // Only check top 3 to limit API calls
        try {
          await this.throttleRequest(); // Respect rate limits
          const profileData = await this.getInstagramProfileInfo(profile.username);
          if (!profileData) continue;
          
          const score = this.scoreProfileMatch(profileData, producerName, searchContext);
          scoredProfiles.push({
            ...profileData,
            score
          });
        } catch (error) {
          console.warn(`Error fetching profile for ${profile.username}:`, error);
          // Continue to next profile
        }
      }
      
      // Sort by score and get the best match
      scoredProfiles.sort((a, b) => b.score - a.score);
      
      const bestMatch = scoredProfiles.length > 0 ? scoredProfiles[0] : null;
      
      // Only consider it a match if the score is high enough
      if (bestMatch && bestMatch.score >= 10) {
        // Cache the result
        globalCache.set(cacheKey, bestMatch, PROFILE_CACHE_TTL);
        return bestMatch;
      }
      
      return null;
    }, {
      name: 'findBestInstagramProfile',
      maxRetries: 2
    });
  }

  private async searchInstagramProfiles(producerName: string, context: string): Promise<InstagramSearchResult[]> {
    const cacheKey = `ddg_search_${producerName.toLowerCase().replace(/\s+/g, '_')}_${context}`;
    
    return this.withRetry(async () => {
      // Check cache first
      const cachedResults = globalCache.get<InstagramSearchResult[]>(cacheKey);
      if (cachedResults) {
        return cachedResults;
      }
      
      // Construct search query: site:instagram.com "Producer Name" music producer
      const query = `site:instagram.com "${producerName}" ${context}`;
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      
      console.log(`Searching DuckDuckGo for Instagram profiles: ${query}`);
      
      const response = await fetch(searchUrl, {
        headers: this.getRequestHeaders()
      });
      
      if (!response.ok) {
        console.error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`);
        return [];
      }
      
      const html = await response.text();
      
      // Extract Instagram profile links from search results
      const results: InstagramSearchResult[] = [];
      const profileUrlRegex = /https:\/\/(www\.)?instagram\.com\/([^\/\s"]+)/g;
      
      let match;
      const foundUsernames = new Set<string>();
      
      while ((match = profileUrlRegex.exec(html)) !== null) {
        const username = match[2];
        
        // Skip if username contains invalid characters or is likely not a username
        if (username.includes('/') || 
            username === 'p' || 
            username === 'explore' || 
            username === 'accounts' ||
            foundUsernames.has(username)) {
          continue;
        }
        
        // Extract title from the nearby result
        let title = '';
        const titleMatch = html.substring(Math.max(0, match.index - 200), match.index + 200)
          .match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([^<]+)<\/a>/);
        
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
        
        results.push({
          username,
          url: `https://instagram.com/${username}`,
          title
        });
        
        foundUsernames.add(username);
      }
      
      // Cache the results
      globalCache.set(cacheKey, results, SEARCH_CACHE_TTL);
      
      return results;
    }, {
      name: 'searchInstagramProfiles',
      maxRetries: 2
    });
  }

  private async getInstagramProfileInfo(username: string): Promise<InstagramProfile | null> {
    const cacheKey = `ig_profile_${username.toLowerCase()}`;
    
    return this.withRetry(async () => {
      // Check cache first
      const cachedProfile = globalCache.get<InstagramProfile>(cacheKey);
      if (cachedProfile) {
        return cachedProfile;
      }
      
      console.log(`Fetching Instagram profile info for: ${username}`);
      
      // Use the new Instagram API endpoint
      const url = `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
      
      const response = await fetch(url, {
        headers: this.getRequestHeaders()
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`Instagram profile not found: ${username}`);
          return null;
        }
        
        console.error(`Instagram API error: ${response.status} ${response.statusText}`);
        return null;
      }
      
      let data: any;
      try {
        data = await response.json();
      } catch (error) {
        console.error(`Failed to parse Instagram response as JSON for ${username}:`, error);
        return null;
      }
      
      // Check for the expected data structure
      if (!data.graphql?.user) {
        console.log(`No user data returned for: ${username}`);
        return null;
      }
      
      const user = data.graphql.user;
      
      const profile: InstagramProfile = {
        username: user.username,
        fullName: user.full_name || '',
        bio: user.biography || '',
        externalUrl: user.external_url || '',
        verified: user.is_verified || false,
        url: `https://instagram.com/${user.username}`,
        followers: user.edge_followed_by?.count || 0,
        posts: user.edge_owner_to_timeline_media?.count || 0,
        score: 0
      };
      
      // Cache the profile info
      globalCache.set(cacheKey, profile, PROFILE_CACHE_TTL);
      
      return profile;
    }, {
      name: 'getInstagramProfileInfo',
      maxRetries: 1,
      baseDelayMs: 2000
    });
  }

  private scoreProfileMatch(profile: InstagramProfile, producerName: string, context: string): number {
    let score = 0;
    const normalizedName = producerName.toLowerCase();
    const normalizedUsername = profile.username.toLowerCase();
    const normalizedFullName = profile.fullName.toLowerCase();
    const normalizedBio = profile.bio.toLowerCase();
    
    // Check if producer name appears in username
    if (normalizedUsername.includes(normalizedName) || 
        normalizedName.includes(normalizedUsername.replace(/[^a-z0-9]/g, ''))) {
      score += SCORE_WEIGHTS.nameInUsername;
    }
    
    // Check if producer name appears in full name
    if (normalizedFullName.includes(normalizedName) || 
        normalizedName.includes(normalizedFullName)) {
      score += SCORE_WEIGHTS.nameInTitle;
    }
    
    // Check if bio contains relevant keywords
    if (normalizedBio.includes('producer') || normalizedBio.includes('prod by')) {
      score += SCORE_WEIGHTS.producerInBio;
    }
    
    if (normalizedBio.includes('music') || normalizedBio.includes('beat')) {
      score += SCORE_WEIGHTS.musicInBio;
    }
    
    if (normalizedBio.includes('artist') || normalizedBio.includes('songwriter')) {
      score += SCORE_WEIGHTS.artistInBio;
    }
    
    if (normalizedBio.includes('official') || 
        normalizedBio.includes('booking') || 
        normalizedBio.includes('management')) {
      score += SCORE_WEIGHTS.officialInBio;
    }
    
    // Bonus for verified accounts
    if (profile.verified) {
      score += SCORE_WEIGHTS.verifiedBadge;
    }
    
    // Bonus for having an external URL
    if (profile.externalUrl) {
      score += SCORE_WEIGHTS.hasExternalUrl;
    }
    
    // Bonus for accounts with significant followers
    if (profile.followers > 1000) {
      score += SCORE_WEIGHTS.followersThreshold;
    }
    
    // Bonus for accounts with multiple posts
    if (profile.posts > 10) {
      score += SCORE_WEIGHTS.postsThreshold;
    }
    
    return score;
  }
}

// Type definitions
interface InstagramSearchResult {
  username: string;
  url: string;
  title: string;
}

interface InstagramProfile {
  username: string;
  fullName: string;
  bio: string;
  externalUrl: string;
  verified: boolean;
  url: string;
  followers: number;
  posts: number;
  score: number;
}

interface ScoredProfile extends InstagramProfile {
  score: number;
}

const worker = new SocialEnrichmentWorker();

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    await worker.run();
    
    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    console.error("Worker execution error:", error);
    
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
