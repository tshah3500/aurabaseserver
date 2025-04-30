const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

// Load env variables
dotenv.config();

const app = express();
const PORT = 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to Supabase
const database = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.post('/api/add-event', async (req, res) => {
  const { name, auraPoints, description, groupName: submittedGroupName } = req.body; // name = nominee

  console.log('Received request:', {
    name,
    auraPoints,
    description,
    submittedGroupName,
    submittedGroupNameType: typeof submittedGroupName
  });

  try {
    // Step 1: Lookup nominee's user_id and verify they are in the group
    const { data: nomineeUser, error: userError } = await database
      .from('users')
      .select('user_id, group_name, name')
      .eq('name', name)
      .single();

    console.log('Found nominee data:', {
      ...nomineeUser,
      groupNameType: nomineeUser ? typeof nomineeUser.group_name : 'undefined',
      isArray: nomineeUser ? Array.isArray(nomineeUser.group_name) : false
    });
    
    if (userError || !nomineeUser) {
      return res.status(400).json({ error: 'Nominee not found in users table' });
    }

    // Verify the nominee is in the submitted group
    const userGroups = Array.isArray(nomineeUser.group_name) 
      ? nomineeUser.group_name 
      : [nomineeUser.group_name];
    
    console.log('Comparison details:', {
      userGroups,
      submittedGroupName,
      exactMatches: userGroups.map(g => ({
        group: g,
        matches: g === submittedGroupName,
        submittedLength: submittedGroupName.length,
        groupLength: g.length
      }))
    });

    if (!userGroups.includes(submittedGroupName)) {
      return res.status(400).json({ 
        error: 'Nominee is not a member of the specified group',
        debug: {
          userGroups,
          submittedGroupName,
          name: nomineeUser.name,
          exactMatches: userGroups.map(g => ({
            group: g,
            matches: g === submittedGroupName,
            submittedLength: submittedGroupName.length,
            groupLength: g.length
          }))
        }
      });
    }

    const userIdOfNominee = nomineeUser.user_id;

    // Step 2: Insert into events table (always with is_approved = false)
    const { data: eventData, error: eventError } = await database
      .from('events')
      .insert([
        {
          name,
          user_id: userIdOfNominee,
          aura_points: parseInt(auraPoints),
          description,
          group_name: submittedGroupName,
          is_approved: false // Always initialize to false
        }
      ])
      .select();

    if (eventError || !eventData || eventData.length === 0) {
      return res.status(500).json({ error: eventError?.message || 'Event insert failed' });
    }

    const eventId = eventData[0].event_id;

    // Step 3: Get people_map for group
    const { data: groupData, error: groupError } = await database
      .from('groups')
      .select('people_map')
      .eq('group_id', submittedGroupName)
      .single();

    if (groupError || !groupData || !groupData.people_map) {
      return res.status(500).json({ error: 'Group or people_map not found' });
    }

    const peopleMap = groupData.people_map;

    // Step 4: Build pending entries for reviewers
    const pendingInserts = Object.entries(peopleMap)
      .map(([reviewerId, reviewerName]) => ({
        event_id: eventId,
        approved: false,
        reviewed: false,  // Initialize reviewed status
        name_of_nominee: name,
        user_id_of_nominee: userIdOfNominee,
        name_of_reviewer: reviewerName,
        user_id_of_reviewer: reviewerId
      }));

    // Step 5: Insert pending entries
    const { error: pendingError } = await database
      .from('pending')
      .insert(pendingInserts);

    if (pendingError) {
      return res.status(500).json({ error: pendingError.message });
    }

    res.status(201).json({ message: 'Event and pending reviews created successfully.' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/dashboard-results', async (req, res) => {
  try {
    const { group_id } = req.query;

    if (!group_id) {
      return res.status(400).json({ error: 'Missing group_id parameter' });
    }

    console.log('Group ID:', group_id);

    const { data, error } = await database
      .from('events') // replace with your table name
      .select('name, aura_points')
      .eq('group_name', group_id)
      .eq('is_approved', true);

    console.log('Data:', data);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Group and sum aura points by user name
    const userTotals = {};

    data.forEach(event => {
      const { name, aura_points } = event;
      if (!userTotals[name]) {
        userTotals[name] = 0;
      }
      userTotals[name] += aura_points;
    });

    // Convert into array and sort descending by total aura points
    const topUsers = Object.entries(userTotals)
      .map(([name, total_aura_points]) => ({ name, total_aura_points }))
      .sort((a, b) => b.total_aura_points - a.total_aura_points)
      .slice(0, 5); // Get top 5

    res.status(200).json(topUsers);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/get-default-group', async (req, res) => {
  try {
    const { userid } = req.query;

    if (!userid) {
      return res.status(400).json({ error: 'Missing userid parameter' });
    }

    const { data, error } = await database
      .from('users')
      .select('group_name')
      .eq('user_id', userid)
      .single(); // only 1 user per UUID

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data || !data.group_name || data.group_name.length === 0) {
      return res.status(200).json({}); // return empty object if no group
    }

    const firstGroupName = data.group_name[0];
    console.log('First group name:', firstGroupName);
    res.status(200).json({ group: firstGroupName });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get pending reviews for a user in a specific group
app.get('/api/pending-reviews', async (req, res) => {
  try {
    const { group_id, user_id } = req.query;

    if (!group_id || !user_id) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log('Fetching pending reviews with params:', { group_id, user_id }); // Debug log

    // First get the pending reviews
    const { data: pendingData, error: pendingError } = await database
      .from('pending')
      .select('*')
      .eq('user_id_of_reviewer', user_id)
      .eq('reviewed', false);  // Only fetch unreviewed items

    if (pendingError) {
      console.error('Pending query error:', pendingError);
      return res.status(500).json({ error: pendingError.message });
    }

    if (!pendingData || pendingData.length === 0) {
      return res.status(200).json([]);
    }

    // Get the associated events
    const eventIds = pendingData.map(p => p.event_id);
    const { data: eventsData, error: eventsError } = await database
      .from('events')
      .select('*')
      .in('event_id', eventIds)
      .eq('group_name', group_id);

    if (eventsError) {
      console.error('Events query error:', eventsError);
      return res.status(500).json({ error: eventsError.message });
    }

    // Combine the data
    const combinedData = pendingData.map(pending => {
      const event = eventsData.find(e => e.event_id === pending.event_id);
      if (!event) return null;
      
      return {
        ...pending,
        events: event
      };
    }).filter(item => item !== null);

    console.log('Combined data:', combinedData); // Debug log

    res.status(200).json(combinedData);

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle review decisions
app.post('/api/review-event', async (req, res) => {
  try {
    const { pendingId, eventId, isApproved, groupId } = req.body;

    if (!pendingId || !eventId || isApproved === undefined || !groupId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 1. Update the pending entry
    const { error: updateError } = await database
      .from('pending')
      .update({ 
        approved: isApproved,
        reviewed: true  // Mark as reviewed when processed
      })
      .eq('pending_id', pendingId);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    // 2. Get total number of people in the group
    const { data: groupData, error: groupError } = await database
      .from('groups')
      .select('people_map')
      .eq('group_id', groupId)
      .single();

    if (groupError) {
      return res.status(500).json({ error: groupError.message });
    }

    const totalGroupMembers = Object.keys(groupData.people_map).length;

    // 3. Count approved reviews for this event
    const { data: approvedData, error: countError } = await database
      .from('pending')
      .select('*')
      .eq('event_id', eventId)
      .eq('approved', true);

    if (countError) {
      return res.status(500).json({ error: countError.message });
    }

    // 4. Calculate approval percentage and check if >= 50%
    const approvedCount = approvedData.length;
    const approvalPercentage = (approvedCount / totalGroupMembers) * 100;
    
    console.log('Approval stats:', {
      approvedCount,
      totalGroupMembers,
      approvalPercentage,
      eventId
    });

    if (approvalPercentage >= 50) {
      // Update event approval status
      const { error: eventUpdateError } = await database
        .from('events')
        .update({ is_approved: true })
        .eq('event_id', eventId);

      if (eventUpdateError) {
        return res.status(500).json({ error: eventUpdateError.message });
      }
      
      console.log(`Event ${eventId} approved with ${approvalPercentage}% approval`);
    }

    res.status(200).json({ 
      message: 'Review processed successfully',
      approvalPercentage,
      wasApproved: approvalPercentage >= 50
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Root route
app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});