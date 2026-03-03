// Validates that route params expected to be numeric IDs are actually valid integers.
// Returns 400 with clear message instead of letting invalid IDs cause PostgreSQL errors (500).
//
// Usage in route files:
//   const { validateId } = require('../middleware/validateId');
//   router.get('/:id/tricks', validateId('id'), async (req, res) => { ... });
//
// Usage for multiple params:
//   router.post('/:id/tricks/:trickId/like', validateId('id', 'trickId'), async (req, res) => { ... });

function validateId(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params[name];
      if (value === undefined) continue; // param not in this route
      
      // Allow string achievement IDs (e.g. 'trick_master') — skip non-numeric expected params
      // Only validate params that look like they should be numeric
      const asNum = Number(value);
      if (!Number.isInteger(asNum) || asNum < 1) {
        return res.status(400).json({ 
          error: `Invalid ${name}: must be a positive integer`,
          param: name,
          received: value
        });
      }
    }
    next();
  };
}

module.exports = { validateId };
