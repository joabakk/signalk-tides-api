var assert = require('assert');


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


var motionpredict = require((process.env.APP_DIR_FOR_CODE_COVERAGE || '../lib/') + 'motionpredict.js').withMathFunc(MathFunc);


describe('getPositionByVeloAndTime', function () {
    describe('when position=[1,2,3], velocity=[1,1,1] and dt=1.0', function () {
        it('should return a new position of [2,3,4]', function () {
		var position = [1,2,3];
		var velocity = [1,1,1];
		var dt = 1.0;
                var result = motionpredict.getPositionByVeloAndTime(position, velocity, dt);
                var expected = [2,3,4];

                assert.deepEqual(expected, result);
        });
    })
});




describe('calcCPATime', function () {
    describe('when track1(pos=[0,0,0], velocity=[0,1,0]) and track2(pos=[0,1,0], velocity=[0,0,0])', function () {
        it('should return a TCPA of 1s', function () {
		var position1 = [0,0,0];
		var velocity1 = [0,1,0];
		var position2 = [0,1,0];
		var velocity2 = [0,0,0];

		var result = motionpredict.calcCPATime(position1,velocity1,position2,velocity2);
                var expected = 1;

                assert.deepEqual(expected, result);
        });
    }),

    describe('when track1(pos=[0,1,0], velocity=[0,1,0]) and track2(pos=[0,1,0], velocity=[0,1,0])', function () {
        it('should return an undefined TCPA', function () {
		var position1 = [0,1,0];
		var velocity1 = [0,1,0];
		var position2 = [0,1,0];
		var velocity2 = [0,1,0];

		var result = motionpredict.calcCPATime(position1,velocity1,position2,velocity2);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    })

    describe('when track1(pos=[0,2,0], velocity=[0,1,0]) and track2(pos=[0,1,0], velocity=[0,0,0])', function () {
        it('should return a TCPA of -1s', function () {
		var position1 = [0,2,0];
		var velocity1 = [0,1,0];
		var position2 = [0,1,0];
		var velocity2 = [0,0,0];

		var result = motionpredict.calcCPATime(position1,velocity1,position2,velocity2);
                var expected = -1;

                assert.deepEqual(expected, result);
        });
    })
});



describe('calcCPAPositionTarget1', function () {
    describe('when track1(pos=[0,0,0], velocity=[0,1,0]) and track2(pos=[1,1,0], velocity=[0,0,0])', function () {
        it('should return a CPA of [0,1,0]', function () {
		var position1 = [0,0,0];
		var velocity1 = [0,1,0];
		var position2 = [1,1,0];
		var velocity2 = [0,0,0];

		var result = motionpredict.calcCPAPositionTarget1(position1,velocity1,position2,velocity2);
                var expected = [0,1,0];

                assert.deepEqual(expected, result);
        });
    }),

    describe('when track1(pos=[0,1,0], velocity=[0,1,0]) and track2(pos=[1,1,0], velocity=[0,1,0])', function () {
        it('should return an undefined CPA', function () {
		var position1 = [0,1,0];
		var velocity1 = [0,1,0];
		var position2 = [1,1,0];
		var velocity2 = [0,1,0];

		var result = motionpredict.calcCPAPositionTarget1(position1,velocity1,position2,velocity2);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    })

    describe('when track1(pos=[0,2,0], velocity=[0,1,0]) and track2(pos=[1,1,0], velocity=[0,0,0])', function () {
        it('should return a CPA of [0,1,0]', function () {
		var position1 = [0,2,0];
		var velocity1 = [0,1,0];
		var position2 = [1,1,0];
		var velocity2 = [0,0,0];

		var result = motionpredict.calcCPAPositionTarget1(position1,velocity1,position2,velocity2);
                var expected = [0,1,0];

                assert.deepEqual(expected, result);
        });
    })
});



describe('calcCPAPositionTarget2', function () {
    describe('when track1(pos=[0,0,0], velocity=[0,1,0]) and track2(pos=[1,1,0], velocity=[0,0,0])', function () {
        it('should return a CPA of [1,1,0]', function () {
		var position1 = [0,0,0];
		var velocity1 = [0,1,0];
		var position2 = [1,1,0];
		var velocity2 = [0,0,0];

		var result = motionpredict.calcCPAPositionTarget2(position1,velocity1,position2,velocity2);
                var expected = [1,1,0];

                assert.deepEqual(expected, result);
        });
    }),

    describe('when track1(pos=[0,1,0], velocity=[0,1,0]) and track2(pos=[1,1,0], velocity=[0,1,0])', function () {
        it('should return an undefined CPA', function () {
		var position1 = [0,1,0];
		var velocity1 = [0,1,0];
		var position2 = [1,1,0];
		var velocity2 = [0,1,0];

		var result = motionpredict.calcCPAPositionTarget2(position1,velocity1,position2,velocity2);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    })

    describe('when track1(pos=[0,2,0], velocity=[0,1,0]) and track2(pos=[1,1,0], velocity=[0,0,0])', function () {
        it('should return a CPA of [1,1,0]', function () {
		var position1 = [0,2,0];
		var velocity1 = [0,1,0];
		var position2 = [1,1,0];
		var velocity2 = [0,0,0];

		var result = motionpredict.calcCPAPositionTarget2(position1,velocity1,position2,velocity2);
                var expected = [1,1,0];

                assert.deepEqual(expected, result);
        });
    })
});



describe('calcInterceptTime', function () {
    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,0,0], velocity=[0,0,0])', function () {
        it('should return a time of 1s', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,0,0];
		var targetVelo = [0,0,0];

		var result = motionpredict.calcInterceptTime(icptPos,icptVelo,targetPos,targetVelo);
                var expected = 1.0;

                assert.deepEqual(expected, result);
        });
    }),

    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,1,0], velocity=[-1,0,0])', function () {
        it('should return a time of 1s', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,1,0];
		var targetVelo = [-1,0,0];

		var result = motionpredict.calcInterceptTime(icptPos,icptVelo,targetPos,targetVelo);
                var expected = 1.0;

                assert.deepEqual(expected, result);
        });
    }),

    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,0,0], velocity=[1,0,0])', function () {
        it('should return a time of undefined', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,0,0];
		var targetVelo = [1,0,0];

		var result = motionpredict.calcInterceptTime(icptPos,icptVelo,targetPos,targetVelo);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    }),

    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,0,0], velocity=[2,0,0])', function () {
        it('should return a time of undefined', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,0,0];
		var targetVelo = [1,0,0];

		var result = motionpredict.calcInterceptTime(icptPos,icptVelo,targetPos,targetVelo);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    })
});



describe('calcInterceptPosition', function () {
    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,0,0], velocity=[0,0,0])', function () {
        it('should return a position of [1,0,0]', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,0,0];
		var targetVelo = [0,0,0];

		var result = motionpredict.calcInterceptPosition(icptPos,icptVelo,targetPos,targetVelo);
                var expected = [1,0,0];

                assert.deepEqual(expected, result);
        });
    }),

    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,1,0], velocity=[-1,0,0])', function () {
        it('should return a position of [0,1,0]', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,1,0];
		var targetVelo = [-1,0,0];

		var result = motionpredict.calcInterceptPosition(icptPos,icptVelo,targetPos,targetVelo);
                var expected = [0,1,0];

                assert.deepEqual(expected, result);
        });
    }),

    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,0,0], velocity=[1,0,0])', function () {
        it('should return a time of undefined', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,0,0];
		var targetVelo = [1,0,0];

		var result = motionpredict.calcInterceptPosition(icptPos,icptVelo,targetPos,targetVelo);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    }),

    describe('when interceptor(pos=[0,0,0], velocity=1) and target(pos=[1,0,0], velocity=[2,0,0])', function () {
        it('should return a time of undefined', function () {
		var icptPos = [0,0,0];
		var icptVelo = 1.0;
		var targetPos = [1,0,0];
		var targetVelo = [1,0,0];

		var result = motionpredict.calcInterceptPosition(icptPos,icptVelo,targetPos,targetVelo);
                var expected = undefined;

                assert.deepEqual(expected, result);
        });
    })
});



describe('calcApproachSpeed', function () {
    describe('when interceptor(pos=[0,1,0], velocity=[0,-1,0]) and target(pos=[0,0,0], velocity=[0,0,0])', function () {
        it('should return a position of [1,0,0]', function () {
                var icptPos = [0,1,0];
                var icptVelo = [0,-1,0];
                var myPos = [0,0,0];
                var myVelo = [0,0,0];

                var result = motionpredict.calcApproachSpeed(myPos,myVelo,icptPos,icptVelo);
                var expected = 1.0;

                assert.deepEqual(expected, result);
        });
    })
});



describe('calcArrivalTime', function () {
    describe('when interceptor(pos=[0,1,0], velocity=[0,-1,0]) and target(pos=[0,0,0], velocity=[0,0,0])', function () {
        it('should return a position of [1,0,0]', function () {
                var icptPos = [0,1,0];
                var icptVelo = [0,-1,0];
                var myPos = [0,0,0];
                var myVelo = [0,0,0];

                var result = motionpredict.calcArrivalTime(myPos,myVelo,icptPos,icptVelo);
                var expected = 1.0;

                assert.deepEqual(expected, result);
        });
    })
});


