const { Pool } = require('pg');

// Railway automatycznie ustawia DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Query helper
const query = (text, params) => pool.query(text, params);

// Initialize database tables
const initDatabase = async () => {
  try {
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        public_id TEXT UNIQUE,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        is_admin BOOLEAN DEFAULT FALSE,
        is_coach BOOLEAN DEFAULT FALSE,
        is_public BOOLEAN DEFAULT TRUE,
        role TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tricks table
      CREATE TABLE IF NOT EXISTS tricks (
        id SERIAL PRIMARY KEY,
        public_id TEXT UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        description TEXT,
        full_description TEXT,
        video_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- User tricks progress
      CREATE TABLE IF NOT EXISTS user_tricks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trick_id INTEGER NOT NULL REFERENCES tricks(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'todo',
        notes TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, trick_id)
      );

      -- Events table
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        public_id TEXT UNIQUE,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        location TEXT NOT NULL,
        location_url TEXT,
        spots INTEGER DEFAULT 10,
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Event attendees
      CREATE TABLE IF NOT EXISTS event_attendees (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(event_id, user_id)
      );

      -- News table
      CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        public_id TEXT UNIQUE,
        title TEXT NOT NULL,
        message TEXT,
        type TEXT DEFAULT 'info',
        emoji TEXT,
        event_details JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Articles table
      CREATE TABLE IF NOT EXISTS articles (
        id SERIAL PRIMARY KEY,
        public_id TEXT UNIQUE,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        content TEXT,
        read_time TEXT DEFAULT '5 min',
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Database tables created');

    // Seed data if empty
    await seedData();

  } catch (error) {
    console.error('Database init error:', error);
    throw error;
  }
};

// Seed initial data
const seedData = async () => {
  try {
    // Check if tricks exist
    const tricksResult = await pool.query('SELECT COUNT(*) FROM tricks');
    if (parseInt(tricksResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO tricks (name, category, difficulty, description, full_description, video_url) VALUES
        ('Getting Started', 'preparation', 'beginner', 'Learn the basics before hitting the water.', 'Before you start wakeboarding, understand the equipment, safety, and fundamentals.', NULL),
        ('Surface 180', 'surface', 'beginner', 'A half rotation on the water surface.', 'Start by riding with comfortable speed. Initiate rotation by turning head and shoulders.', 'https://grabby.s3.eu-west-3.amazonaws.com/fwt/tricks/7ce820c0-dad7-406f-9ba5-5161be72c07a-video#t=0.001'),
        ('Wake Jump', 'air', 'beginner', 'Basic jump using the wake as a ramp.', 'Approach wake with progressive edge. Keep knees bent and handle low.', NULL),
        ('Kicker 180', 'kicker', 'intermediate', 'Half rotation off a kicker.', 'Approach ramp with moderate speed. Stay centered as you ride up.', NULL),
        ('50-50 Grind', 'rail', 'beginner', 'Ride straight across the rail.', 'Pop onto rail and center weight over middle of board.', NULL)
      `);
      console.log('✅ Seeded tricks');
    }

    // Check if events exist
    const eventsResult = await pool.query('SELECT COUNT(*) FROM events');
    if (parseInt(eventsResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO events (name, date, time, location, location_url, spots) VALUES
        ('Morning Ride', '2026-01-25', '10:00', 'Flat Water', 'https://www.flatwater.space', 8),
        ('Afternoon Session', '2026-01-26', '14:00', 'Flat Water', 'https://www.flatwater.space', 10),
        ('Pro Training', '2026-01-28', '09:00', 'Lunar Cable Park', 'https://www.lunarcablepark.com', 6),
        ('Weekend Wakeboard', '2026-02-07', '11:00', 'Flat Water', 'https://www.flatwater.space', 12)
      `);
      console.log('✅ Seeded events');
    }

    // Check if news exist
    const newsResult = await pool.query('SELECT COUNT(*) FROM news');
    if (parseInt(newsResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO news (title, message, type, emoji, event_details) VALUES
        ('Wings for Life World Run', 'Run for those who cant!', 'event', '🏃', '{"description": "Join thousands worldwide in this unique charity run.", "date": "2026-05-03", "time": "13:00", "location": "Flat Water", "price": "€25"}'),
        ('Summer Camp 2026', 'Early bird pricing ends soon!', 'event', '🏕️', '{"description": "5-day intensive wakeboarding camp. All levels welcome.", "date": "2026-07-15", "time": "9:00-17:00", "location": "Flat Water", "price": "€239"}')
      `);
      console.log('✅ Seeded news');
    }

    // Check if articles exist
    const articlesResult = await pool.query('SELECT COUNT(*) FROM articles');
    if (parseInt(articlesResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO articles (category, title, description, content, read_time) VALUES
        ('basics', 'What is Cable Wakeboarding?', 'Learn about cable wakeboarding and how it differs from boat wakeboarding.', 'Cable wakeboarding is a form of wakeboarding where the rider is pulled by an overhead cable system instead of a boat. The cable runs in either a straight line (two-tower system) or around a lake in a circuit (full-size cable park). This makes it more accessible, eco-friendly, and allows for unique features like rails and kickers to be placed in the water.

Key differences from boat wakeboarding:
- Consistent pull speed and tension
- No boat wake to jump (uses kickers instead)
- More obstacles like rails, boxes, and fun boxes
- Often more affordable and accessible
- Better for the environment

Cable parks typically have different cable systems for beginners and advanced riders, making it perfect for learning and progression.', '3 min'),
        
        ('basics', 'Essential Gear Guide', 'Everything you need to know about wakeboard equipment.', 'Getting the right gear is essential for a great wakeboarding experience. Here is what you need:

WAKEBOARD
- Beginners: Larger, more buoyant boards (140-150cm)
- Advanced: Smaller, more aggressive boards
- Cable-specific boards have reinforced edges for rails

BINDINGS
- Should fit snugly but comfortably
- Open-toe bindings: Easier to share, more forgiving
- Closed-toe bindings: Better control and response

HELMET
- Required at most cable parks
- Water sports specific helmets recommended
- Must fit securely without obstructing vision

IMPACT VEST
- Provides flotation and protection
- Different from life jackets
- Choose one that allows full range of motion

WETSUIT
- Thickness depends on water temperature
- 3/2mm for summer, 5/4mm for winter
- Shorty suits for warm conditions

Most cable parks rent all necessary equipment, so you can try before you buy!', '5 min'),

        ('basics', 'Your First Day at the Cable', 'What to expect and how to prepare for your first cable wakeboarding session.', 'Your first day at a cable park can be exciting and a bit overwhelming. Here is how to prepare:

BEFORE YOU GO
- Book a beginner session or lesson
- Bring swimwear, towel, and sunscreen
- Arrive 30 minutes early for registration

AT THE PARK
- Complete waiver and registration
- Get fitted for gear (board, helmet, vest)
- Attend the safety briefing

YOUR FIRST RIDE
- Start at the beginner cable or System 2.0
- Learn the deep water start position
- Keep arms straight, let the cable pull you up
- Stay relaxed and knees bent
- Do not try to stand too quickly

COMMON BEGINNER MISTAKES
- Pulling on the handle (keep arms straight!)
- Standing up too fast
- Looking down instead of forward
- Tensing up instead of staying relaxed

TIPS FOR SUCCESS
- Listen to your instructor
- Fall safely - let go of the handle
- Take breaks when tired
- Watch other riders to learn
- Have fun and do not get discouraged!

Most people can ride successfully by the end of their first session with proper instruction.', '6 min'),

        ('safety', 'Water Safety Fundamentals', 'Essential safety knowledge for wakeboarding.', 'Safety should always be your top priority when wakeboarding. Here are the fundamentals:

GENERAL SAFETY RULES
- Always wear a helmet and impact vest
- Never wrap the rope around any body part
- Let go of the handle when you fall
- Stay aware of other riders
- Follow cable park rules and signals

FALLING SAFELY
- Release the handle immediately
- Protect your face with your arms
- Try to fall flat, not head first
- Relax your body on impact
- Swim away from the cable path quickly

WEATHER AWARENESS
- Never ride during lightning storms
- Be cautious in strong winds
- Check water conditions before riding
- Know the signs of hypothermia

OBSTACLE SAFETY
- Start with easy features
- Always check landings are clear
- Progress gradually
- Know your limits

COMMUNICATION
- Learn hand signals used at the park
- Signal OK after falls
- Alert staff to any hazards
- Report injuries immediately

Remember: The best rider is a safe rider. Never sacrifice safety for style!', '4 min'),

        ('safety', 'Understanding Cable Park Rules', 'Know the rules before you ride.', 'Every cable park has rules designed to keep everyone safe. Here are common rules you will encounter:

RIGHT OF WAY
- Fallen riders have priority to get up
- Do not cut in front of other riders
- Wait your turn at obstacles
- Yield to riders on features

CABLE ETIQUETTE
- Only one rider per carrier at full-size cables
- Keep safe distance from rider ahead
- Do not stop in the middle of the cable path
- Exit the water quickly after falling

OBSTACLE RULES
- Check features are clear before hitting them
- One rider on a feature at a time
- Do not sit or stand on obstacles
- Report any damaged features

GENERAL CONDUCT
- Follow staff instructions
- No alcohol or drugs before riding
- Respect other riders and staff
- Keep the park clean

SIGNALS
- Thumbs up = OK / Ready
- Hand on head = Need help
- Waving arm = Stop the cable
- Pointing = Hazard warning

Breaking rules can result in being asked to leave. Most importantly, rules exist to protect you and others - follow them!', '4 min'),

        ('technique', 'Mastering the Deep Water Start', 'The foundation of wakeboarding - getting up from the water.', 'The deep water start is the first skill every wakeboarder must master. Here is how to do it:

BODY POSITION
- Float on your back with board in front
- Knees pulled to chest
- Arms straight, holding handle
- Board perpendicular to cable direction

THE PULL
- Let the cable take up slack slowly
- Keep arms straight - do not pull!
- Let the cable pull you, not the other way
- Stay patient and wait for the pull

STANDING UP
- As tension builds, slowly extend legs
- Keep weight on your heels
- Do not rush - let the board plane first
- Rise gradually, not all at once

COMMON PROBLEMS AND FIXES

Falling Forward:
- Keep arms straighter
- Weight more on heels
- Do not pull on the handle

Falling Backward:
- Bend knees more
- Lean slightly forward
- Keep board perpendicular

Board Goes Sideways:
- Keep equal pressure on both feet
- Stay centered over the board
- Look where you want to go

PRACTICE TIPS
- Start with a shorter rope if available
- Practice the motion on land first
- Stay relaxed - tension is your enemy
- Celebrate small progress!

With practice, the deep water start becomes automatic. Most beginners get it within 5-10 attempts.', '5 min'),

        ('technique', 'Edge Control Basics', 'Learn to control your board and navigate the cable park.', 'Edge control is what separates beginners from intermediate riders. Here is how to master it:

UNDERSTANDING EDGES
- Heelside edge: Leaning back on heels
- Toeside edge: Leaning forward on toes
- Flat base: Board flat on water (unstable)

HEELSIDE RIDING
- Most natural position for beginners
- Weight on heels, knees bent
- Handle at front hip
- Shoulders open to cable direction

TOESIDE RIDING
- Lean forward onto toes
- Knees bent, hips forward
- Handle at back hip
- Look over lead shoulder

SWITCHING EDGES
- Start with subtle weight shifts
- Keep handle close to body
- Use hips to initiate turns
- Look where you want to go

CARVING TURNS
- Progressive edge pressure
- Smooth weight transfer
- Maintain speed through turns
- Keep upper body stable

PRACTICE DRILLS
1. Ride one edge for full lap
2. Practice gentle S-turns
3. Increase carve intensity gradually
4. Combine with speed control

Good edge control enables everything else in wakeboarding. Spend time mastering this before moving to tricks!', '5 min')
      `);
      console.log('✅ Seeded articles');
    }

  } catch (error) {
    console.error('Seed data error:', error);
  }
};

module.exports = {
  query,
  initDatabase,
  pool
};
