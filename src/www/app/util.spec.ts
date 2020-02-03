import { OperationTimedOut } from '../model/errors';
import { timeoutPromise } from './util';

const PROMISE_RESOLVED = 1;

describe('timeoutPromise', () => {
  it('Executes successful promise', () => {
    timeoutPromise(Promise.resolve(PROMISE_RESOLVED), 100, 'Test Promise')
        .catch((err) => {
          fail(`Successful promise was timed out when it should have resolved`);
        })
        .then((value) => {
          expect(value).toEqual(PROMISE_RESOLVED);
        });
    const promiseWithTime = new Promise((resolve, _) => {
      setTimeout(() => {
        resolve(PROMISE_RESOLVED);
      }, 50);
    });
    timeoutPromise(promiseWithTime, 100, 'Test Promise')
        .catch((err) => {
          fail(`Successful timed promise was timed out when it should have resolved`);
        })
        .then((value) => {
          expect(value).toEqual(PROMISE_RESOLVED);
        });
  });

  it('Executes failed promise', () => {
    timeoutPromise(Promise.reject('reason'), 100, 'Test Promise').catch((err) => {
      expect(err).not.toEqual(jasmine.any(OperationTimedOut));
    });
    const promiseWithTime = new Promise((resolve) => {
      setTimeout(() => {
        resolve(PROMISE_RESOLVED);
      }, 50);
    });
    timeoutPromise(promiseWithTime, 100, 'Test Promise').catch((err) => {
      expect(err).not.toEqual(jasmine.any(OperationTimedOut));
    });
  });

  it('Times out promise', () => {
    const promiseWithTime = new Promise((resolve) => {
      setTimeout(() => {
        resolve(1);
      }, 2000);
    });
    timeoutPromise(promiseWithTime, 100, 'Test Promise')
      .then(() => {
        fail(`Promise should have timed out but didn't`);
      })
      .catch((err) => {
        expect(err instanceof OperationTimedOut).toBe(true);
      });
  });
});
