/**
 * Phase 5 Step 4 — QuestionInput unit tests.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';

import { QuestionInput } from './QuestionInput';

beforeEach(() => {
  useGraphStore.setState({
    runId: 'r-1',
    questionAnswerInFlight: new Set(),
  });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('QuestionInput — render', () => {
  it('renders the question text verbatim', () => {
    render(<QuestionInput subtaskId="s-1" question="Should I use A or B?" />);
    expect(screen.getByTestId('question-text-s-1').textContent).toBe(
      'Should I use A or B?',
    );
  });

  it('has a textarea with the autofocus + answer field testid', () => {
    render(<QuestionInput subtaskId="s-1" question="?" />);
    const field = screen.getByTestId('question-answer-field-s-1');
    expect(field.tagName).toBe('TEXTAREA');
  });
});

describe('QuestionInput — submit', () => {
  it('calls answerSubtaskQuestion with the typed text on Send click', async () => {
    const answer = vi.fn(async () => undefined);
    useGraphStore.setState({ answerSubtaskQuestion: answer });
    render(<QuestionInput subtaskId="s-1" question="?" />);
    const field = screen.getByTestId('question-answer-field-s-1');
    fireEvent.change(field, { target: { value: 'option A' } });
    fireEvent.click(screen.getByTestId('question-send-s-1'));
    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith('s-1', 'option A');
    });
  });

  it('submits on Enter without Shift', async () => {
    const answer = vi.fn(async () => undefined);
    useGraphStore.setState({ answerSubtaskQuestion: answer });
    render(<QuestionInput subtaskId="s-1" question="?" />);
    const field = screen.getByTestId('question-answer-field-s-1');
    fireEvent.change(field, { target: { value: 'yes' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: false });
    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith('s-1', 'yes');
    });
  });

  it('does NOT submit on Shift+Enter (newline insert)', () => {
    const answer = vi.fn(async () => undefined);
    useGraphStore.setState({ answerSubtaskQuestion: answer });
    render(<QuestionInput subtaskId="s-1" question="?" />);
    const field = screen.getByTestId('question-answer-field-s-1');
    fireEvent.change(field, { target: { value: 'line1' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(answer).not.toHaveBeenCalled();
  });

  it('disables controls and renders "Sending…" while in flight', () => {
    useGraphStore.setState({
      questionAnswerInFlight: new Set(['s-1']),
    });
    render(<QuestionInput subtaskId="s-1" question="?" />);
    expect(screen.getByTestId('question-send-s-1')).toBeDisabled();
    expect(screen.getByTestId('question-send-s-1').textContent).toMatch(
      /sending/i,
    );
    expect(screen.getByTestId('question-skip-s-1')).toBeDisabled();
    expect(screen.getByTestId('question-answer-field-s-1')).toBeDisabled();
  });
});

describe('QuestionInput — skip', () => {
  it('calls skipSubtaskQuestion on click', async () => {
    const skip = vi.fn(async () => undefined);
    useGraphStore.setState({ skipSubtaskQuestion: skip });
    render(<QuestionInput subtaskId="s-1" question="?" />);
    fireEvent.click(screen.getByTestId('question-skip-s-1'));
    await waitFor(() => {
      expect(skip).toHaveBeenCalledWith('s-1');
    });
  });
});
