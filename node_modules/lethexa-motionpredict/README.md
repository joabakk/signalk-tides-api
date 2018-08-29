lethexa-motionpredict
---------------------

This library is used to predict track position.

  * Intercept-calculation of two tracks. 
  * Closest point of approach of two tracks.
  * Arrival time of one track at another.
  * Approach speed of one track to another.


Usage 
-----
	/////////////////////////////////////////////////
	// Definition of required vector math functions
	// as plugin for the calculations.
	// Change this to adapt to your favourite vector library.
	var MathFunc = {
		add: function(a, b) {
			return [
				a[0] + b[0],
				a[1] + b[1],
				a[2] + b[2]
			];
		},
		sub: function(a, b) {
			return [
				a[0] - b[0],
				a[1] - b[1],
				a[2] - b[2]
			];
		},
		mulScalar: function(a, s) {
			return [
				a[0] * s,
				a[1] * s,
				a[2] * s
			];
		},
		dot: function(a, b) {
			return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		},
		lengthSquared: function(a) {
			return a[0]*a[0] + a[1]*a[1] + a[2]*a[2];
		}
	};
	/////////////////////////////////////////////



	//// THE EXAMPLE ////
	var motionpredict = require('lethexa-motionpredict').withMathFunc(MathFunc);

	// Calculate TCPA
	var position1 = [0,0,0];
	var velocity1 = [0,1,0];

	var position2 = [0,1,0];
	var velocity2 = [0,0,0];

	var tcpa = motionpredict.calcCPATime(position1,velocity1,position2,velocity2);
	console.log('TCPA=' + tcpa);



	// Calculate intercept time
	var icptPos = [0,0,0];
	var icptVelo = 1.0;

	var targetPos = [1,0,0];
	var targetVelo = [0,0,0];

	var ticpt = motionpredict.calcInterceptTime(icptPos,icptVelo,targetPos,targetVelo);

	console.log('T intercept=' + ticpt);



License
-------

This library is published under MIT license.
 

